import { NextResponse } from 'next/server';
import { createAnonClient } from '@/lib/supabase/server';

export async function GET() {
  const supabase = createAnonClient();
  const { data, error } = await supabase
    .from('students')
    .select('id, name, parent_id, parents ( id, name )')
    .order('name');
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}
