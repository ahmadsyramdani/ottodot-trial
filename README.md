# Ottodot Trial Booking

A minimal, backend-led slice of a trial-class booking system for Ottodot. Parents pick a child and a trial class, submit a booking, go through a mocked payment step, and see the result. Teachers see a per-class roster.

The interesting part is **correctness under payment failure, duplicate booking, and the last-seat race** — not frontend polish.

> **Time spent:** ~3h 30m total — 30m design, 45m schema + `confirm_booking` function, 45m API routes, 45m tests + seed, 30m minimal UI, 30m README + `AI_USAGE.md`.

---

## Table of contents

- [Stack](#stack)
- [Quick start](#quick-start)
- [What I built](#what-i-built)
- [The last-seat race](#the-last-seat-race)
- [Data model](#data-model)
- [API endpoints](#api-endpoints)
- [Booking statuses](#booking-statuses)
- [Backend decisions](#backend-decisions)
- [Where each check lives](#where-each-check-lives)
- [Testing](#testing)
- [Manual verification](#manual-verification)
- [Tradeoffs accepted](#tradeoffs-accepted)
- [What I deliberately cut](#what-i-deliberately-cut)
- [What I'd monitor after release](#what-id-monitor-after-release)
- [What I'd do next with more time](#what-id-do-next-with-more-time)
- [Assumptions](#assumptions)
- [Repo layout](#repo-layout)

---

## Stack

- **Next.js 15** (App Router, TypeScript)
- **Supabase / Postgres** for persistence
- **Tailwind** for minimal styling
- **Vitest + PGlite** for tests (in-memory Postgres, no Docker)

Requires **Node.js ≥ 20.19 or ≥ 22.12** (Vitest 4 + Vite 8 dependency).

---

## Quick start

```bash
# 1. Install
npm install

# 2. Create a Supabase project and copy the API keys
#    Dashboard → Project Settings → API

# 3. Create .env.local
cat > .env.local <<'EOF'
NEXT_PUBLIC_SUPABASE_URL=https://xxxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_ROLE_KEY=eyJ...
EOF

# 4. Apply migrations + seed in the Supabase SQL editor, in order:
#    supabase/migrations/0001_init.sql
#    supabase/migrations/0002_confirm_booking.sql
#    supabase/migrations/0003_cancel_booking.sql
#    supabase/seed.sql

# 5. Run the app
npm run dev
# → http://localhost:3000/book
# → http://localhost:3000/admin/roster

# 6. Run tests (no database required — uses in-memory PGlite)
npm test
```

### Optional: real Stripe (sandbox)

The default payment flow is mocked via `/api/payments/:id/simulate`, which calls the same `confirm_booking` RPC the webhook would. To run against a real Stripe sandbox:

```bash
stripe login
stripe listen --forward-to localhost:3000/api/webhooks/stripe
# put the printed whsec_... into .env.local as STRIPE_WEBHOOK_SECRET
# then add STRIPE_SECRET_KEY=sk_test_... and restart `npm run dev`
```

See [docs/stripe.md](docs/stripe.md) for the full walkthrough.

---

## What I built

Trial booking only — **no regular enrollment**.

- **Parent flow** — `/book`: pick a child, pick a class (full classes disabled in the UI), submit, mock a payment outcome, view status.
- **Admin flow** — `/admin/roster`: class list and per-class roster with statuses and a cancel action.
- **Backend** — REST routes for booking creation, payment simulation, status polling, cancellation, and roster fetch.
- **Database** — five tables, one atomic `confirm_booking` RPC that decides the last-seat race, one `cancel_booking` RPC that decrements safely.
- **Tests** — six Vitest cases against in-memory Postgres covering every edge case the prompt asked for.

**Seat capacity is enforced at the database, not the app.** The UI only hides full classes; the DB is the source of truth.

---

## The last-seat race

> User A selects the last available slot and moves to payment. User B selects the same slot. User B completes payment first and confirms. User A then tries to complete payment.

### Approach

A single atomic `UPDATE` decides the winner at the database layer:

```sql
update trial_classes
   set confirmed_count = confirmed_count + 1
 where id = v_booking.trial_class_id
   and confirmed_count < capacity
returning id into v_seated;
```

If the `UPDATE` returns a row, the caller won a seat. If it returns no row, the seat was already taken. There is no read-then-write window, no application-level lock, and no retry loop.

### What happens to the loser

The loser's payment already succeeded at the PSP — I can't un-capture it. So the loser's booking is marked `payment_failed` with `failure_reason = 'seat_taken_refund_pending'`, and the payment attempt is left as `succeeded` for a background refund job to pick up. Money is refunded out-of-band.

### Why this approach

| Alternative | Why rejected |
|---|---|
| `SELECT count(*)` then `INSERT` | Classic read-then-write race. Both readers see count=3, both insert. |
| `SELECT ... FOR UPDATE` on the class row | Correct, but holds a lock across two statements and requires careful retry logic. |
| `SERIALIZABLE` isolation + retry loop | Correct, but every booking can hit a serialization failure. Heavy for the benefit. |
| Seat hold with TTL at payment start | Avoids the refund path, but adds a reaper job, expiry races, and a worse UX when a parent's hold silently expires. |

### Why not a seat hold?

The prompt's scenario **requires** two users to reach payment for the same last seat. A hold would prevent that. Refund-on-loss is simpler to reason about, and the failure mode (money that needs refunding) is easier to reconcile than a broken booking.

### Tradeoff accepted

A losing payer must be refunded. In this slice, the refund is out-of-band. In production, a background job would retry until Stripe confirms.

---

## Data model

```
parents ──┐
          ├──< students ──┐
          │               │
          │               ├──< bookings >── trial_classes
          │               │       │
          │               │       └──< payment_attempts
          │               │
          └──< (RLS: parent sees own children only)
```

### Tables

| Table | Purpose | Key columns |
|---|---|---|
| `parents` | Account holder | `id`, `name`, `email` |
| `students` | Children under a parent | `id`, `parent_id`, `name` |
| `trial_classes` | One row per class | `id`, `subject`, `starts_at`, `capacity`, `confirmed_count` |
| `bookings` | Intent to book | `id`, `student_id`, `trial_class_id`, `status` |
| `payment_attempts` | One per payment try | `id`, `booking_id`, `status`, `provider_ref`, `failure_reason` |
| `processed_webhook_events` | Stripe idempotency | `id` (event id) |

The model separates **"the intent to book"** (`bookings`) from **"the money movement"** (`payment_attempts`), which keeps the state machines independent.

### Constraints that encode invariants

```sql
-- One active booking per (student, class): pending_payment OR confirmed
create unique index bookings_unique_active
  on bookings(student_id, trial_class_id)
  where status in ('pending_payment', 'confirmed');

-- Capacity check as belt-and-braces
constraint capacity_bounds check (confirmed_count >= 0 and confirmed_count <= capacity);

-- One payment attempt per Stripe PaymentIntent
create unique index on payment_attempts(provider_ref) where provider_ref is not null;
```

**Why `confirmed_count` is denormalized on `trial_classes`:** the seat check becomes a single-row atomic update. Counting rows from `bookings` inside a transaction requires `FOR UPDATE` or Serializable isolation, which serializes all bookings for a class. The counter avoids that.

**Cost:** if the counter ever drifts from the true count of `confirmed` rows, rosters lie. Mitigation: `cancel_booking` decrements in the same transaction that flips status, and the drift check below runs in monitoring.

---

## API endpoints

| Method | Route | Purpose |
|---|---|---|
| `GET`  | `/api/students` | List children + parent info (dropdown) |
| `GET`  | `/api/trial-classes` | List classes with current occupancy |
| `POST` | `/api/bookings` | Create a `pending_payment` booking + `initiated` attempt |
| `GET`  | `/api/bookings/:bookingId` | Status poll |
| `POST` | `/api/payments/:attemptId/simulate` | Mock payment — calls `confirm_booking` on success |
| `POST` | `/api/bookings/:bookingId/cancel` | Calls `cancel_booking` RPC |
| `GET`  | `/api/trial-classes/:id/roster` | Teacher view |
| `POST` | `/api/webhooks/stripe` | Real PSP webhook (signature-verified, idempotent) |

### PostgreSQL functions

| Function | Purpose |
|---|---|
| `confirm_booking(booking_id uuid, payment_ref text)` | Atomic seat grab + status flip. Idempotent. |
| `cancel_booking(booking_id uuid, reason text)` | Decrements `confirmed_count` if booking was `confirmed`, flips status to `cancelled`. |

---

## Booking statuses

```
pending_payment ──► confirmed
      │
      ├──► payment_failed   (card declined, or lost the last-seat race)
      │
      └──► cancelled        (user abandoned)

confirmed ──► cancelled     (admin or user cancellation)
```

| Status | Meaning | Counts against capacity? |
|---|---|---|
| `pending_payment` | Booking created, awaiting payment | No |
| `confirmed` | Paid and seated | **Yes** |
| `payment_failed` | Payment declined or seat lost | No |
| `cancelled` | Cancelled after confirmation | No (decremented) |

### Payment attempt statuses

`initiated` → `succeeded` | `failed` → (optionally) `refunded`

---

## Backend decisions

### Duplicate prevention

A single partial unique index on `bookings(student_id, trial_class_id)` covering `status in ('pending_payment', 'confirmed')`. This prevents both duplicate pending rows **and** starting a new booking for a class the student is already confirmed in. Failed/cancelled rows fall outside the index, so retries and rebooking work.

App-level checks would race. Indexes cannot. The API maps Postgres error code `23505` to HTTP `409`.

### Payment failure

The `/simulate` endpoint and the Stripe webhook both update the `payment_attempt` and `booking` **without touching `confirmed_count`**. Only `confirm_booking` is allowed to increment it, and it's only called on a successful payment. A failed payment therefore cannot consume a seat.

### Idempotency

`confirm_booking` returns early if the booking is already `confirmed`. Combined with the webhook dedupe table (`processed_webhook_events` keyed on Stripe event id), retries are safe at two layers.

### Atomic seat grab

See [The last-seat race](#the-last-seat-race).

### Cancel path

`cancel_booking` decrements `confirmed_count` in the same transaction that flips the status, so the counter can't drift. Direct SQL updates to `bookings` are discouraged in favor of the RPC.

---

## Where each check lives

| Check | Layer | Why here |
|---|---|---|
| Disable full classes in dropdown | **UI** | Cosmetic; can be stale |
| Reject duplicate booking with 409 | **API + DB** | API maps the DB unique-violation to a friendly error |
| Reject booking for class without seats | **DB** (`confirm_booking` `WHERE` clause) | Atomic; the only safe layer |
| Confirm exactly once per payment | **DB** (`confirm_booking` idempotency) | Handles webhook retries |
| Decrement on cancel | **DB** (`cancel_booking`) | Keeps counter in sync |
| Refund the race loser | **Background job** | Out-of-band; retries until successful |
| Detect counter drift | **Monitoring** | Alert if `confirmed_count != count(*)` per class |

**The rule of thumb:** UI hides, API maps errors, **DB enforces**. Anything that must hold under concurrency belongs in the DB.

---

## Testing

Tests run against **PGlite** (in-memory Postgres 16 + `pgcrypto`), so `npm test` needs no database.

```bash
npm test
```

Expected:

```
✓ tests/booking.test.ts (6 tests)
  ✓ confirms a booking on an empty class and increments count
  ✓ rejects duplicate booking for same student+class when already confirmed
  ✓ blocks confirm on a full class (no seat granted)
  ✓ payment failure never confirms
  ✓ LAST-SEAT RACE: only one of two competing bookings ends up confirmed
  ✓ cancelling a confirmed booking frees the seat
```

### What the tests cover

| Test | Invariant |
|---|---|
| Confirm on empty class | Happy path, count increments |
| Duplicate booking | Partial unique index blocks a second active booking |
| Confirm on full class | `WHERE confirmed_count < capacity` returns 0 rows |
| Payment failure | Booking becomes `payment_failed`; count untouched |
| **Last-seat race** | Exactly one confirm, one `payment_failed`, count capped at 4, loser flagged `seat_taken_refund_pending` |
| Cancel | Decrements count in same transaction |

### Note on true concurrency

PGlite is single-connection, so the race test proves **logic** (two confirms → one winner) but not **isolation**. Real isolation is guaranteed by Postgres's row-level locking on the `UPDATE`, which PGlite inherits. For CI-grade verification, the same test suite can run against a real Postgres with `Promise.all([confirmA, confirmB])` — that's on the "next" list.

---

## Manual verification

After `npm run dev`, walk through these:

1. **Happy path** — `/book` → pick Amy + Physics → submit → Pay (success) → status `confirmed`. Class shows 1/4.
2. **Duplicate** — repeat with Amy + Physics → `duplicate_booking` error.
3. **Payment failure** — Ben + Physics → Decline → `payment_failed`. Physics still 1/4.
4. **Last-seat race** — two tabs, both `/book`:
   - Tab A: Cody + Chemistry (3/4) → submit → **don't pay yet**.
   - Tab B: Cora + Chemistry → submit → Pay (success). Chemistry → 4/4.
   - Tab A: Pay (success). Status `payment_failed`. Cody's attempt shows `seat_taken_refund_pending`.
   - Confirm Chemistry never exceeds 4.
5. **Cancel** — `/admin/roster/<chemistry>` → cancel a confirmed row → count drops to 3.

---

## Tradeoffs accepted

| Decision | Accepted cost |
|---|---|
| **No seat hold at payment time** | Losing payer must be refunded out-of-band. Matches the prompt's scenario, which requires two users to reach payment for the same last seat. |
| **`confirmed_count` denormalized** | Drift risk if a `confirmed` booking is deleted without decrementing. Mitigated by routing cancel through the `cancel_booking` RPC. |
| **No auth in this slice** | Parent identity is preseeded; RLS is sketched but inert. |
| **Mocked payment in the default demo** | Real PSP path exists via webhook but isn't demoed in the UI. |
| **PGlite tests are sequential** | True isolation is Postgres' job; the atomic `UPDATE` is the guarantee. |
| **Service-role API reads** | Fine for a demo; production would use RLS + anon key for reads. |

---

## What I deliberately cut

- **Auth** — parent identity is preseeded. RLS policies are sketched in [docs/rls.md](docs/rls.md).
- **Real payment provider in the demo UI** — the simulate endpoint exercises the same `confirm_booking` RPC the webhook would.
- **Refund automation** — flagged as `seat_taken_refund_pending`, refunded manually in the demo.
- **Waiting list** — no rebooking when a seat frees.
- **Email / SMS** — no parent notifications.
- **Timezone UI and i18n** — `starts_at` is stored as `timestamptz` but displayed in browser locale.
- **Frontend polish** — plain Tailwind, no design system.
- **Multi-seat bookings** — one booking per submission.

---

## What I'd monitor after release

| Signal | Why | Alert threshold |
|---|---|---|
| `payment_attempts.failure_reason = 'seat_taken_refund_pending'` count | Race losers awaiting refund. Expect near-zero after early-adopter traffic; any spike means users are hammering the same class. | Any value > 0 for > 1 hour |
| `confirmed_count` vs `count(*) from bookings where status='confirmed'` per class | Counter drift | Any mismatch |
| 409 rate on `/api/bookings` | Duplicate attempts, possible UX bug | > 5% of traffic |
| `confirm_booking` p95 latency | Row lock contention on `bookings` | > 500ms |
| Webhook 5xx rate | Stripe will retry; repeated failure means a bug | Any sustained 5xx |
| `processed_webhook_events` growth rate | Detects a webhook flood | Unexpected spikes |

Drift check query:

```sql
select
  tc.id,
  tc.subject,
  tc.confirmed_count,
  count(b.id) filter (where b.status = 'confirmed') as actual
from trial_classes tc
left join bookings b on b.trial_class_id = tc.id
group by tc.id, tc.subject, tc.confirmed_count
having tc.confirmed_count <> count(b.id) filter (where b.status = 'confirmed');
```

---

## What I'd do next with more time

1. **Postgres concurrency test in CI.** Run `Promise.all([confirmA, confirmB])` against a real Postgres with a connection pool. PGlite proves logic; a pooled Postgres proves isolation under true parallelism.
2. **Refund automation.** Add `refund_status` and `refund_attempts` columns to `payment_attempts`, a background worker that retries Stripe refunds, and an alert on stale `seat_taken_refund_pending`.
3. **RLS wired to Supabase Auth.** Replace the preseeded parent picker with cookie-based auth. Sketch in [docs/rls.md](docs/rls.md).
4. **Short TTL seat hold** at "start payment" to eliminate the refund path, with a reaper job. Only worth it if refund volume becomes a problem.
5. **Exclusion constraint** to prevent the same student from being confirmed in overlapping classes (would require denormalizing `starts_at` onto `bookings` for `EXCLUDE` to work).
6. **Structured logging** with a correlation id per booking, so a single booking's story is traceable end-to-end.

---

## Assumptions

- Parent identity is **preseeded**; the parent picker in the UI stands in for a session. In production, this is a Supabase Auth cookie, and every write route checks `auth.uid()` against the target student's `parent_id`.
- The mock payment endpoint exercises the same code path as the real Stripe webhook (`confirm_booking` RPC). No behavior depends on which path is taken.
- Trial class capacity is **per class**, default 4, matching the prompt — not per time slot.
- `starts_at` is stored as `timestamptz`. Display uses browser locale.
- The seed is **idempotent** for parents/students/classes. The bookings insert is not; wipe and re-seed if you re-run it.
- Node.js ≥ 20.19 or ≥ 22.12 required (Vitest 4 + Vite 8).

---

## Repo layout

```
.
├── app/
│   ├── api/
│   │   ├── bookings/
│   │   │   ├── route.ts                    # POST create booking
│   │   │   └── [bookingId]/
│   │   │       ├── route.ts                # GET status
│   │   │       └── cancel/route.ts         # POST cancel
│   │   ├── payments/[attemptId]/
│   │   │   ├── simulate/route.ts           # mock payment
│   │   │   └── create-intent/route.ts      # real Stripe intent
│   │   ├── students/route.ts               # list children
│   │   ├── trial-classes/
│   │   │   ├── route.ts                    # list classes
│   │   │   └── [id]/roster/route.ts        # teacher roster
│   │   └── webhooks/stripe/route.ts        # real PSP webhook
│   ├── admin/roster/
│   │   ├── page.tsx                        # class picker
│   │   └── [classId]/page.tsx              # roster table
│   ├── book/page.tsx                       # parent flow
│   └── page.tsx                            # landing
├── lib/
│   ├── supabase/server.ts                  # anon + service clients
│   └── types.ts
├── supabase/
│   ├── migrations/
│   │   ├── 0001_init.sql
│   │   ├── 0002_confirm_booking.sql
│   │   └── 0003_cancel_booking.sql
│   └── seed.sql
├── tests/booking.test.ts
├── docs/
│   ├── rls.md
│   └── stripe.md
├── AI_USAGE.md
├── README.md
└── package.json
```

---

## License

MIT — this is a take-home exercise, use it as you like.
