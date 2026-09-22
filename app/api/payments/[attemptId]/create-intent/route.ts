import { NextResponse } from 'next/server';
import Stripe from 'stripe';
import { createServiceClient } from '@/lib/supabase/server';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2024-06-20' });

export async function POST(_: Request, { params }: { params: { attemptId: string } }) {
  const supabase = createServiceClient();

  const { data: attempt, error } = await supabase
    .from('payment_attempts')
    .select('id, status')
    .eq('id', params.attemptId)
    .single();
  if (error || !attempt) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  if (attempt.status !== 'initiated') return NextResponse.json({ error: 'attempt_closed' }, { status: 409 });

  const intent = await stripe.paymentIntents.create({
    amount: 2500,           // SGD $25.00
    currency: 'sgd',
    metadata: { attempt_id: attempt.id },
    automatic_payment_methods: { enabled: true },
  });

  await supabase.from('payment_attempts')
    .update({ provider_ref: intent.id, updated_at: new Date().toISOString() })
    .eq('id', attempt.id);

  return NextResponse.json({ clientSecret: intent.client_secret });
}
