import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ attemptId: string }> }
) {
  const { attemptId } = await params;
  const { outcome } = await req.json();
  const supabase = createServiceClient();

  const { data: attempt, error } = await supabase
    .from('payment_attempts')
    .select('id, booking_id, status')
    .eq('id', attemptId)
    .single();

  if (error || !attempt) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  if (attempt.status !== 'initiated') {
    return NextResponse.json({ error: 'attempt_closed' }, { status: 409 });
  }

  if (outcome === 'fail') {
    await supabase
      .from('payment_attempts')
      .update({
        status: 'failed',
        failure_reason: 'card_declined',
        updated_at: new Date().toISOString(),
      })
      .eq('id', attempt.id);

    await supabase
      .from('bookings')
      .update({ status: 'payment_failed', updated_at: new Date().toISOString() })
      .eq('id', attempt.booking_id);

    return NextResponse.json({ status: 'payment_failed' });
  }

  const { data, error: rpcError } = await supabase.rpc('confirm_booking', {
    p_booking_id: attempt.booking_id,
    p_payment_ref: `sim_${attempt.id}`,
  });
  if (rpcError) {
    return NextResponse.json({ error: rpcError.message }, { status: 500 });
  }
  return NextResponse.json({ booking: data });
}
