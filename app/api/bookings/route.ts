import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';

export async function POST(req: NextRequest) {
  const { studentId, trialClassId } = await req.json();
  if (!studentId || !trialClassId)
    return NextResponse.json({ error: 'missing_fields' }, { status: 400 });

  const supabase = createServiceClient();

  const { data: booking, error } = await supabase
    .from('bookings')
    .insert({ student_id: studentId, trial_class_id: trialClassId })
    .select()
    .single();

  if (error) {
    if (error.code === '23505')
      return NextResponse.json({ error: 'duplicate_booking' }, { status: 409 });
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  const { data: attempt, error: attErr } = await supabase
    .from('payment_attempts')
    .insert({ booking_id: booking.id })
    .select()
    .single();

  if (attErr) return NextResponse.json({ error: attErr.message }, { status: 500 });

  return NextResponse.json({ booking, attempt });
}
