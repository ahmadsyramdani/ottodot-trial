import { describe, it, expect, beforeAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

let db: PGlite;

function read(relPath: string) {
  return readFileSync(path.resolve(process.cwd(), relPath), 'utf8');
}

async function freshBooking(student: string, klass: string) {
  const { rows } = await db.query<{ id: string }>(
    `insert into bookings (student_id, trial_class_id) values ($1,$2) returning id`,
    [student, klass]
  );
  const { rows: att } = await db.query<{ id: string }>(
    `insert into payment_attempts (booking_id) values ($1) returning id`,
    [rows[0].id]
  );
  return { bookingId: rows[0].id, attemptId: att[0].id };
}

async function confirm(bookingId: string, ref?: string) {
  // provider_ref has a unique constraint — generate one when not supplied.
  const r = ref ?? `ref_${Math.random().toString(36).slice(2)}_${Date.now()}`;
  const { rows } = await db.query<{ status: string }>(
    `select * from confirm_booking($1, $2)`,
    [bookingId, r]
  );
  return rows[0];
}

const CLASS_EMPTY  = '00000000-0000-0000-0000-00000000000a';
const CLASS_3_OF_4 = '00000000-0000-0000-0000-00000000000b';
const CLASS_FULL   = '00000000-0000-0000-0000-00000000000c';

const AMY  = 'a1111111-1111-1111-1111-111111111111';
const BEN  = 'b1111111-1111-1111-1111-111111111111';
const CARA = 'c1111111-1111-1111-1111-111111111111';
const CODY = 'c2222222-2222-2222-2222-222222222222';
const CORA = 'c3333333-3333-3333-3333-333333333333';

beforeAll(async () => {
  db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(read('supabase/migrations/0001_init.sql'));
  await db.exec(read('supabase/migrations/0002_confirm_booking.sql'));
  await db.exec(read('supabase/migrations/0003_cancel_booking.sql'));
  await db.exec(read('supabase/seed.sql'));
});

describe('trial booking invariants', () => {
  it('confirms a booking on an empty class and increments count', async () => {
    const { bookingId } = await freshBooking(CORA, CLASS_EMPTY);
    const b = await confirm(bookingId);
    expect(b.status).toBe('confirmed');

    const { rows } = await db.query<{ confirmed_count: number }>(
      `select confirmed_count from trial_classes where id=$1`,
      [CLASS_EMPTY]
    );
    expect(rows[0].confirmed_count).toBe(1);
  });

  it('rejects duplicate booking for same student+class when already confirmed', async () => {
    // Cora is already confirmed on CLASS_EMPTY from the previous test.
    // The new insert should be blocked by bookings_unique_active.
    await expect(freshBooking(CORA, CLASS_EMPTY)).rejects.toThrow(/duplicate/i);
  });

  it('blocks confirm on a full class (no seat granted)', async () => {
    const { bookingId } = await freshBooking(CODY, CLASS_FULL);
    const b = await confirm(bookingId);
    expect(b.status).toBe('payment_failed');

    const { rows } = await db.query<{ confirmed_count: number }>(
      `select confirmed_count from trial_classes where id=$1`,
      [CLASS_FULL]
    );
    expect(rows[0].confirmed_count).toBe(4);
  });

  it('payment failure never confirms', async () => {
    const { bookingId, attemptId } = await freshBooking(BEN, CLASS_EMPTY);

    await db.query(
      `update payment_attempts set status='failed', failure_reason='card_declined' where id=$1`,
      [attemptId]
    );
    await db.query(
      `update bookings set status='payment_failed' where id=$1`,
      [bookingId]
    );

    const { rows } = await db.query<{ status: string }>(
      `select status from bookings where id=$1`,
      [bookingId]
    );
    expect(rows[0].status).toBe('payment_failed');
  });

  it('LAST-SEAT RACE: only one of two competing bookings ends up confirmed', async () => {
    // CLASS_3_OF_4 already has Amy, Ben, and Cara confirmed in seed data.
    // Cody and Cora are both free for that class. One of them gets the last seat.
    const a = await freshBooking(CODY, CLASS_3_OF_4);
    const b = await freshBooking(CORA, CLASS_3_OF_4);

    const bResult = await confirm(b.bookingId, 'pay_b');
    const aResult = await confirm(a.bookingId, 'pay_a');

    expect([aResult.status, bResult.status].sort()).toEqual([
      'confirmed',
      'payment_failed',
    ]);

    const { rows } = await db.query<{ confirmed_count: number }>(
      `select confirmed_count from trial_classes where id=$1`,
      [CLASS_3_OF_4]
    );
    expect(rows[0].confirmed_count).toBe(4);

    const loserId = aResult.status === 'payment_failed' ? a.attemptId : b.attemptId;
    const { rows: loserRows } = await db.query<{
      status: string;
      failure_reason: string;
    }>(
      `select status, failure_reason from payment_attempts where id=$1`,
      [loserId]
    );
    expect(loserRows[0].status).toBe('succeeded');
    expect(loserRows[0].failure_reason).toBe('seat_taken_refund_pending');
  });

  it('cancelling a confirmed booking frees the seat', async () => {
    const before = await db.query<{ confirmed_count: number }>(
      `select confirmed_count from trial_classes where id=$1`,
      [CLASS_3_OF_4]
    );

    const { rows: bookingRows } = await db.query<{ id: string }>(
      `select id from bookings where trial_class_id=$1 and status='confirmed' limit 1`,
      [CLASS_3_OF_4]
    );

    await db.query(`select cancel_booking($1, 'test')`, [bookingRows[0].id]);

    const after = await db.query<{ confirmed_count: number }>(
      `select confirmed_count from trial_classes where id=$1`,
      [CLASS_3_OF_4]
    );
    expect(after.rows[0].confirmed_count).toBe(
      before.rows[0].confirmed_count - 1
    );
  });
});
