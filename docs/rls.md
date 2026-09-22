# Row Level Security (RLS) sketch

This is a design artifact, not wired into the current demo. The take-home slice has **no auth** — parent identity is preseeded and the parent picker stands in for a session. This document shows where RLS would go, what the policies would look like, and what changes in the app when auth is added.

**Read this with one thing in mind:** RLS is a **visibility boundary**, not a correctness mechanism. It controls *whose rows a user can see and modify*. It does **not** enforce the last-seat race, duplicate prevention, or capacity — those are enforced by `confirm_booking` and the partial unique indexes, and they hold regardless of who's logged in.

---

## What changes when auth is added

| Current slice | With Supabase Auth |
|---|---|
| Parent picker in `/book` is a dropdown of all seeded parents | Session cookie identifies the caller; dropdown lists only their children |
| API routes read `NEXT_PUBLIC_SUPABASE_ANON_KEY` and query freely | API routes use a cookie-bound client; RLS filters results automatically |
| Write routes use `SUPABASE_SERVICE_ROLE_KEY` | Write routes use the same cookie-bound client; RLS enforces ownership |
| `confirm_booking` and `cancel_booking` are callable by anyone with the RPC name | `REVOKE EXECUTE` from `anon`/`authenticated`; wrap in `SECURITY DEFINER` functions that check ownership |
| No per-parent isolation anywhere | `auth.uid()` = `parents.id`; every policy keys off that |

---

## Enabling RLS

```sql
alter table parents                  enable row level security;
alter table students                 enable row level security;
alter table trial_classes            enable row level security;
alter table bookings                 enable row level security;
alter table payment_attempts         enable row level security;
alter table processed_webhook_events enable row level security;
```

**Enabling RLS with no policies = deny-all to `anon` and `authenticated`.** The service role bypasses RLS entirely (that's the escape hatch for webhooks and background jobs). So enabling RLS is safe — you then add only the policies you need.

---

## Policies

### `parents`

A parent can read and update only their own row.

```sql
create policy parents_select_self on parents
  for select using (auth.uid() = id);

create policy parents_update_self on parents
  for update using (auth.uid() = id);
```

No `insert` policy — parents are created out of band (invite flow, admin action).

---

### `students`

A parent sees and manages only their own children.

```sql
create policy students_select_own on students
  for select using (auth.uid() = parent_id);

create policy students_insert_own on students
  for insert with check (auth.uid() = parent_id);

create policy students_update_own on students
  for update using (auth.uid() = parent_id);

create policy students_delete_own on students
  for delete using (auth.uid() = parent_id);
```

**Note the difference between `using` and `with check`:**
- `using` filters which existing rows a user can see/target.
- `with check` validates the row *after* write — this is what stops a parent from setting `parent_id` to someone else's id.

Both are needed. Forgetting `with check` on an insert policy is a classic privilege-escalation bug.

---

### `trial_classes`

Public read so the booking page can list classes. No client writes.

```sql
create policy trial_classes_select_all on trial_classes
  for select using (true);
```

`confirmed_count` is intentionally public — it's shown in the UI as "3/4". No `insert`/`update`/`delete` policies means only the service role can modify these rows.

---

### `bookings`

A parent sees and creates bookings only for their own children.

```sql
create policy bookings_select_own on bookings
  for select using (
    exists (
      select 1 from students s
      where s.id = bookings.student_id
        and s.parent_id = auth.uid()
    )
  );

create policy bookings_insert_own on bookings
  for insert with check (
    exists (
      select 1 from students s
      where s.id = student_id
        and s.parent_id = auth.uid()
    )
  );
```

**No `update` or `delete` policies.** Status transitions (`pending_payment` → `confirmed`, etc.) happen through the `confirm_booking` / `cancel_booking` RPCs, which run as `SECURITY DEFINER`. This is deliberate: allowing direct status updates from a client would let a parent self-confirm without paying.

---

### `payment_attempts`

A parent can see attempts on their own bookings.

```sql
create policy payment_attempts_select_own on payment_attempts
  for select using (
    exists (
      select 1 from bookings b
      join students s on s.id = b.student_id
      where b.id = payment_attempts.booking_id
        and s.parent_id = auth.uid()
    )
  );
```

No client write policies. Attempts are created and updated by the backend.

---

### `processed_webhook_events`

Service role only. **No policies = no client access.**

---

## Locking down the RPCs

`confirm_booking` and `cancel_booking` currently run as the caller. If they're callable from a browser session, a parent could theoretically confirm their own booking without paying.

### Option A: revoke client access, keep service-role use

```sql
revoke execute on function confirm_booking(uuid, text) from anon, authenticated;
revoke execute on function cancel_booking(uuid, text)  from anon, authenticated;
```

Only the service role (used by API routes and webhooks) can call them. **This is what the current slice effectively does** — the routes use the service key.

### Option B: make them `SECURITY DEFINER` with an ownership check

If you want clients to cancel their own bookings (a common product requirement), wrap `cancel_booking`:

```sql
create or replace function cancel_own_booking(p_booking_id uuid)
returns bookings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking bookings;
begin
  -- Ownership check: caller must be the parent of this booking's student.
  select b.* into v_booking
    from bookings b
    join students s on s.id = b.student_id
   where b.id = p_booking_id
     and s.parent_id = auth.uid();

  if not found then
    raise exception 'not_found_or_not_owned';
  end if;

  return cancel_booking(p_booking_id, 'user_cancelled');
end;
$$;

revoke execute on function cancel_own_booking(uuid) from public;
grant  execute on function cancel_own_booking(uuid) to authenticated;
```

**Two things that matter in `SECURITY DEFINER` functions:**
1. **Always set `search_path`.** Otherwise a malicious user can create a schema with a shadowing table and hijack the function. `set search_path = public` is the minimum.
2. **Do the ownership check inside the function.** Don't trust the caller to pass the right `auth.uid()`.

**Never wrap `confirm_booking` this way.** Confirmation should only happen as a result of a payment (webhook or server-side simulate). There is no legitimate client-initiated confirm path.

---

## What RLS does *not* protect

These are the invariants RLS has nothing to do with, and it's worth saying explicitly:

| Invariant | Enforced by |
|---|---|
| `confirmed_count <= capacity` | `UPDATE ... WHERE confirmed_count < capacity` inside `confirm_booking` |
| At most one confirmed booking per (student, class) | Partial unique index `bookings_unique_active` |
| Cancel decrements the counter | `cancel_booking` RPC (single transaction) |
| Webhook retries are idempotent | `processed_webhook_events` + `confirm_booking` early return |

If you wrote RLS but got the seat check wrong, two parents could still race each other into an overbooked class — RLS would happily let both through. **RLS is per-row visibility. Correctness is per-invariant logic.**

---

## Testing RLS

If you wire this up, add these to your test suite:

```sql
-- Simulate a logged-in parent
set local role authenticated;
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111"}';

-- Should see only Amy
select * from students;
-- Expected: 1 row (Amy)

-- Should see only bookings for Amy's classes
select * from bookings;
-- Expected: only rows where student_id = Amy's id

-- Should NOT be able to see another parent's student
select * from students where id = 'b1111111-1111-1111-1111-111111111111';
-- Expected: 0 rows

-- Should NOT be able to insert a student under another parent
insert into students (parent_id, name)
values ('22222222-2222-2222-2222-222222222222', 'Sneaky');
-- Expected: RLS violation

reset role;
```

The `set local request.jwt.claims` trick lets you test as any user id without going through actual authentication. In PGlite you'd need to fake `auth.uid()` — either replace it with a session variable in tests, or skip RLS tests in PGlite and run them against real Postgres.

---

## Migration path from the current slice

If you want to add auth without rewriting everything:

1. Enable RLS and add the policies above.
2. Add Supabase Auth (email OTP is fastest).
3. Change `createAnonClient` → `createServerClient` (cookie-bound) in read routes.
4. Change write routes from `createServiceClient` to the cookie-bound client too, and rely on RLS.
5. Keep the service client **only** for the Stripe webhook — it must bypass RLS.
6. `REVOKE EXECUTE` on `confirm_booking` from `anon`/`authenticated`.
7. Add the `cancel_own_booking` wrapper if clients should self-cancel.
8. Update the `/book` page to read the current parent from the session instead of listing all parents.

Nothing in the schema or the `confirm_booking` logic changes. RLS is additive.

---

## Summary

| Concern | Where it lives |
|---|---|
| Who can see which rows | RLS |
| Who can create which rows | RLS `with check` |
| Status transitions that require payment | RPC with `REVOKE EXECUTE`, or `SECURITY DEFINER` with ownership check |
| Seat capacity and race conditions | `confirm_booking`, partial unique indexes |
| Webhook idempotency | `processed_webhook_events` + `confirm_booking` early return |

RLS and correctness are orthogonal. This slice is entirely about correctness; RLS is documented here to show where it would slot in without disturbing the invariants.
