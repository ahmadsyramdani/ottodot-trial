import { NextResponse } from 'next/server';
import { createAnonClient } from '@/lib/supabase/server';

export async function GET(
  _: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const supabase = createAnonClient();
  const { data, error } = await supabase
    .from('bookings')
    .select(`
      id, status, created_at,
      students ( id, name, parents ( name, email ) ),
      trial_classes ( id, subject, starts_at, capacity, confirmed_count )
    `)
    .eq('trial_class_id', id)
    .order('created_at');

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json(data);
}
