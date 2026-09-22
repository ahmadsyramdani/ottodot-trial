import { NextResponse } from 'next/server';
import { createAnonClient } from '@/lib/supabase/server';

export async function GET() {
  const supabase = createAnonClient();
  const { data, error } = await supabase
    .from('trial_classes')
    .select('id, subject, starts_at, capacity, confirmed_count')
    .order('starts_at');
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}
