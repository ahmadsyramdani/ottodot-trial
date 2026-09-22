import Link from 'next/link';

export default function Home() {
  return (
    <main className="p-10 space-y-4">
      <h1 className="text-2xl font-bold">Ottodot Trial Booking</h1>
      <ul className="list-disc pl-6">
        <li><Link className="text-blue-600 underline" href="/book">Book a trial class</Link></li>
        <li><Link className="text-blue-600 underline" href="/admin/roster">Admin roster</Link></li>
      </ul>
    </main>
  );
}
