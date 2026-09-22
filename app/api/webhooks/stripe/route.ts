import { NextRequest, NextResponse } from 'next/server';
import Stripe from 'stripe';
import { createServiceClient } from '@/lib/supabase/server';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2024-06-20' });

// Next.js App Router: raw body required for signature verification.
export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const sig = req.headers.get('stripe-signature');
  const raw = await req.text();

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(raw, sig!, process.env.STRIPE_WEBHOOK_SECRET!);
  } catch (err: any) {
    return NextResponse.json({ error: `bad_signature: ${err.message}` }, { status: 400 });
  }

  const supabase = createServiceClient();

  // Idempotency: insert event id; if conflict, we've already handled it.
  const { error: dupErr } = await supabase
    .from('processed_webhook_events')
    .insert({ id: event.id });
  if (dupErr && dupErr.code === '23505') {
    return NextResponse.json({ ok: true, duplicate: true });
  }

  try {
    switch (event.type) {
      case 'payment_intent.succeeded': {
        const pi = event.data.object as Stripe.PaymentIntent;
        const attemptId = pi.metadata?.attempt_id;
        if (!attemptId) break;

        const { data: attempt } = await supabase
          .from('payment_attempts')
          .select('id, booking_id')
          .eq('id', attemptId)
          .single();
        if (!attempt) break;

        // Atomic confirm. If we lose the last-seat race, confirm_booking marks
        // the booking payment_failed and the attempt seat_taken_refund_pending.
        const { error: rpcErr } = await supabase.rpc('confirm_booking', {
          p_booking_id: attempt.booking_id,
          p_payment_ref: pi.id,
        });
        if (rpcErr) throw new Error(`confirm_booking failed: ${rpcErr.message}`);

        // Refund if we lost the seat.
        const { data: post } = await supabase
          .from('payment_attempts')
          .select('status, failure_reason')
          .eq('id', attemptId)
          .single();

        if (post?.failure_reason === 'seat_taken_refund_pending') {
          await stripe.refunds.create({ payment_intent: pi.id, reason: 'duplicate' });
          await supabase.from('payment_attempts')
            .update({ status: 'refunded', updated_at: new Date().toISOString() })
            .eq('id', attemptId);
        }
        break;
      }

      case 'payment_intent.payment_failed': {
        const pi = event.data.object as Stripe.PaymentIntent;
        const attemptId = pi.metadata?.attempt_id;
        if (!attemptId) break;

        await supabase.from('payment_attempts')
          .update({
            status: 'failed',
            failure_reason: pi.last_payment_error?.message ?? 'payment_failed',
            updated_at: new Date().toISOString(),
          })
          .eq('id', attemptId);

        const { data: attempt } = await supabase
          .from('payment_attempts')
          .select('booking_id')
          .eq('id', attemptId)
          .single();

        if (attempt) {
          await supabase.from('bookings')
            .update({ status: 'payment_failed', updated_at: new Date().toISOString() })
            .eq('id', attempt.booking_id);
        }
        break;
      }

      default:
        // ignore
        break;
    }

    return NextResponse.json({ ok: true });
  } catch (err: any) {
    // Important: if we crash after inserting the dedupe row, retry will be blocked.
    // Options: (a) delete the dedupe row on error and return 500 for retry,
    //          (b) record a failure and alert. We'll do (a).
    await supabase.from('processed_webhook_events').delete().eq('id', event.id);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
