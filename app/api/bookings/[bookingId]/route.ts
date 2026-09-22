import { NextResponse } from 'next/server';
import { createAnonClient } from '@/lib/supabase/server';

export async function GET(
  _: Request,
  { params }: { params: Promise<{ bookingId: string }> }
) {
  const { bookingId } = await params;
  const supabase = createAnonClient();

  const { data, error } = await supabase
    .from('bookings')
    .select(`
      id, status, created_at,
      students ( id, name ),
      trial_classes ( id, subject, starts_at, capacity, confirmed_count ),
      payment_attempts ( id, status, failure_reason )
    `)
    .eq('id', bookingId)
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 404 });
  }
  return NextResponse.json(data);
}
