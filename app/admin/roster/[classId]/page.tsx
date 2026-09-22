'use client';
import { use, useEffect, useState } from 'react';

type RosterRow = {
  id: string;
  status: string;
  created_at: string;
  students: {
    name: string;
    parents: { name: string; email: string } | null;
  } | null;
  trial_classes: {
    subject: string;
    starts_at: string;
    capacity: number;
    confirmed_count: number;
  } | null;
};

export default function Roster({
  params,
}: {
  params: Promise<{ classId: string }>;
}) {
  const { classId } = use(params);
  const [rows, setRows] = useState<RosterRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setError(null);
    const res = await fetch(`/api/trial-classes/${classId}/roster`);
    const json = await res.json();

    if (!res.ok || !Array.isArray(json)) {
      setError(json?.error ?? 'Failed to load roster');
      setRows([]);
      return;
    }
    setRows(json);
  }

  useEffect(() => {
    load();
  }, [classId]);

  async function cancel(bookingId: string) {
    await fetch(`/api/bookings/${bookingId}/cancel`, { method: 'POST' });
    load();
  }

  const head = rows[0]?.trial_classes;

  return (
    <main className="p-10 space-y-4 max-w-4xl">
      <h1 className="text-2xl font-bold">
        {head
          ? `${head.subject} — ${new Date(head.starts_at).toLocaleString()}`
          : 'Roster'}
      </h1>
      {head && (
        <p className="text-sm text-gray-600">
          Confirmed {head.confirmed_count} / {head.capacity}
        </p>
      )}

      {error && <p className="text-red-600">Error: {error}</p>}

      <table className="w-full border text-sm">
        <thead className="bg-gray-100">
          <tr>
            <th className="border p-2 text-left">Student</th>
            <th className="border p-2 text-left">Parent</th>
            <th className="border p-2 text-left">Status</th>
            <th className="border p-2 text-left">Created</th>
            <th className="border p-2"></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="border p-2">{r.students?.name ?? '—'}</td>
              <td className="border p-2">
                {r.students?.parents?.name ?? '—'}
                <br />
                <span className="text-xs text-gray-500">
                  {r.students?.parents?.email ?? ''}
                </span>
              </td>
              <td className="border p-2">{r.status}</td>
              <td className="border p-2">
                {new Date(r.created_at).toLocaleString()}
              </td>
              <td className="border p-2">
                {r.status === 'confirmed' && (
                  <button
                    className="text-red-600 underline"
                    onClick={() => cancel(r.id)}
                  >
                    cancel
                  </button>
                )}
              </td>
            </tr>
          ))}
          {rows.length === 0 && !error && (
            <tr>
              <td className="border p-2 text-gray-500" colSpan={5}>
                No bookings for this class.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </main>
  );
}
