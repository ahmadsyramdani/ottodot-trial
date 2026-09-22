'use client';
import { useEffect, useState } from 'react';

type Student = { id: string; name: string; parents: { name: string } | null };
type TrialClass = {
  id: string; subject: string; starts_at: string;
  capacity: number; confirmed_count: number;
};
type BookingResult = {
  booking?: { id: string; status: string };
  attempt?: { id: string };
  error?: string;
};

export default function BookPage() {
  const [students, setStudents] = useState<Student[]>([]);
  const [classes, setClasses] = useState<TrialClass[]>([]);
  const [studentId, setStudentId] = useState('');
  const [classId, setClassId] = useState('');

  const [bookingId, setBookingId] = useState<string | null>(null);
  const [attemptId, setAttemptId] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/students').then(r => r.json()).then(setStudents);
    fetch('/api/trial-classes').then(r => r.json()).then(setClasses);
  }, []);

  async function submitBooking() {
    setError(null); setStatus(null);
    const res = await fetch('/api/bookings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ studentId, trialClassId: classId }),
    });
    const json: BookingResult = await res.json();
    if (!res.ok) { setError(json.error ?? 'error'); return; }
    setBookingId(json.booking!.id);
    setAttemptId(json.attempt!.id);
    setStatus('pending_payment');
  }

  async function simulate(outcome: 'success' | 'fail') {
    if (!attemptId) return;
    const res = await fetch(`/api/payments/${attemptId}/simulate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ outcome }),
    });
    const json = await res.json();
    if (!res.ok) { setError(json.error ?? 'error'); return; }
    setStatus(json.booking?.status ?? json.status);
    // Refresh class list so capacity reflects reality
    fetch('/api/trial-classes').then(r => r.json()).then(setClasses);
  }

  return (
    <main className="p-10 space-y-6 max-w-xl">
      <h1 className="text-2xl font-bold">Book a trial class</h1>

      <div className="space-y-2">
        <label className="block">Child</label>
        <select className="border p-2 w-full" value={studentId} onChange={e => setStudentId(e.target.value)}>
          <option value="">— choose —</option>
          {students.map(s => (
            <option key={s.id} value={s.id}>
              {s.name} ({s.parents?.name ?? 'unknown parent'})
            </option>
          ))}
        </select>
      </div>

      <div className="space-y-2">
        <label className="block">Trial class</label>
        <select className="border p-2 w-full" value={classId} onChange={e => setClassId(e.target.value)}>
          <option value="">— choose —</option>
          {classes.map(c => {
            const full = c.confirmed_count >= c.capacity;
            return (
              <option key={c.id} value={c.id} disabled={full}>
                {c.subject} — {new Date(c.starts_at).toLocaleString()} — {c.confirmed_count}/{c.capacity}{full ? ' (full)' : ''}
              </option>
            );
          })}
        </select>
      </div>

      <button
        className="bg-blue-600 text-white px-4 py-2 rounded disabled:opacity-50"
        disabled={!studentId || !classId || !!bookingId}
        onClick={submitBooking}
      >Submit booking</button>

      {error && <p className="text-red-600">Error: {error}</p>}
      {status && <p>Status: <strong>{status}</strong></p>}

      {bookingId && attemptId && status === 'pending_payment' && (
        <div className="border p-4 space-y-2">
          <p className="font-semibold">Mock payment</p>
          <div className="flex gap-2">
            <button className="bg-green-600 text-white px-4 py-2 rounded" onClick={() => simulate('success')}>
              Pay (success)
            </button>
            <button className="bg-red-600 text-white px-4 py-2 rounded" onClick={() => simulate('fail')}>
              Decline payment
            </button>
          </div>
        </div>
      )}

      {bookingId && (
        <p className="text-sm text-gray-500">Booking id: {bookingId}</p>
      )}
    </main>
  );
}
