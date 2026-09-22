'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';

type TrialClass = {
  id: string; subject: string; starts_at: string;
  capacity: number; confirmed_count: number;
};

export default function RosterIndex() {
  const [classes, setClasses] = useState<TrialClass[]>([]);
  useEffect(() => { fetch('/api/trial-classes').then(r => r.json()).then(setClasses); }, []);

  return (
    <main className="p-10 space-y-4 max-w-2xl">
      <h1 className="text-2xl font-bold">Trial class rosters</h1>
      <ul className="divide-y border rounded">
        {classes.map(c => (
          <li key={c.id} className="p-3 flex justify-between">
            <span>{c.subject} — {new Date(c.starts_at).toLocaleString()} ({c.confirmed_count}/{c.capacity})</span>
            <Link className="text-blue-600 underline" href={`/admin/roster/${c.id}`}>view roster</Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
