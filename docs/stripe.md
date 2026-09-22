# Real Stripe integration (sandbox)

The default demo uses a **mock payment endpoint** (`/api/payments/:attemptId/simulate`) that calls the same `confirm_booking` RPC the real webhook would. This document is the walkthrough for wiring a real Stripe sandbox if you want to demo the full PSP path.

The mock and the real path share the same correctness guarantees — `confirm_booking` decides the last-seat race, the partial unique indexes prevent duplicates, and both fail paths leave the counter untouched. The only difference is who triggers `confirm_booking`: a `fetch()` to `/simulate` versus a signed webhook from Stripe.

---

## Prerequisites

- A Stripe account (free): https://stripe.com
- The Stripe CLI: `brew install stripe/stripe-cli/stripe` (macOS) or see the [install docs](https://docs.stripe.com/stripe-cli)
- `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` in `.env.local`

---

## Sandbox vs. legacy test mode

Stripe now calls its testing environment a **sandbox**. It replaced the older single "test mode".

| | Legacy test mode | Sandboxes |
|---|---|---|
| Number per account | 1 | Up to 5 |
| API keys | One set | **Unique per sandbox** |
| Isolation | Some settings leak to live | Fully isolated — data, settings, webhooks |
| Access control | Anyone with account access | Per-sandbox user access |

**Use a sandbox**, not legacy test mode. It's cleaner, disposable, and won't surprise you if you later onboard a teammate.

### Creating one

**Option A — Dashboard:** account picker (upper left) → **Create sandbox**.

**Option B — CLI, no account required:**

```bash
stripe sandbox create --email you@example.com
```

This prints `secret_key`, `publishable_key`, and a `claim_url`. The sandbox **expires after 7 days** unless you run `stripe sandbox claim`. For a take-home demo, 7 days is plenty and you never touch the Stripe dashboard.

---

## The integration, end to end

```
Parent clicks Pay
   │
   ▼
POST /api/payments/:attemptId/create-intent
   │  Stripe PaymentIntent created
   │  payment_attempts.provider_ref = pi_xxx
   ▼
Browser confirms card with Stripe.js
   │
   ▼
Stripe → POST /api/webhooks/stripe
   │  payment_intent.succeeded
   │  signature verified, event id deduped
   ▼
confirm_booking RPC
   │  atomic seat grab
   ├── seat won  → booking: confirmed
   └── seat lost → booking: payment_failed
                   attempt: seat_taken_refund_pending
                   Stripe refund issued
```

---

## Environment variables

Add to `.env.local`:

```bash
STRIPE_SECRET_KEY=sk_test_...           # from your sandbox
STRIPE_WEBHOOK_SECRET=whsec_...         # see "Local development" below
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_test_...
```

`NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` is only needed if you mount the Stripe Payment Element in the browser. The current slice doesn't, so you can skip it until you build the real payment UI.

---

## Local development

The fastest loop is Stripe CLI forwarding.

```bash
# 1. Authenticate (opens a browser)
stripe login

# 2. Forward webhooks to your local Next.js
stripe listen --forward-to localhost:3000/api/webhooks/stripe
# Prints something like:
#   > Ready! You are using Stripe API Version [...]
#   > Your webhook signing secret is whsec_abc123...
```

Copy the `whsec_...` into `.env.local`, then **restart `npm run dev`** (env vars are read at startup).

Trigger an event without going through the UI:

```bash
stripe trigger payment_intent.succeeded
```

That will hit your webhook with a real signed payload. Check the terminal running `npm run dev` — you should see a 200. If you see a 400 with `bad_signature`, your `STRIPE_WEBHOOK_SECRET` didn't reload.

---

## Testing with a real card

Stripe test cards work in the sandbox. The two you'll use most:

| Card | Behavior |
|---|---|
| `4242 4242 4242 4242` | Always succeeds |
| `4000 0000 0000 0002` | Always declines |

Any future expiry, any CVC, any postal code.

To exercise the real path in the browser, you need a Stripe Payment Element mounted on a page that:

1. Calls `/api/payments/:attemptId/create-intent` and gets `clientSecret`.
2. Uses `@stripe/react-stripe-js` to render the element.
3. On confirm, lets Stripe send the webhook.

That's ~40 minutes of UI work. For the demo video, the mock `/simulate` path exercises the same `confirm_booking` RPC and is faster to show.

---

## Webhook handler — what it does and why

The handler is at [`app/api/webhooks/stripe/route.ts`](../app/api/webhooks/stripe/route.ts). Four things it gets right:

### 1. Signature verification

```ts
event = stripe.webhooks.constructEvent(
  raw, sig!, process.env.STRIPE_WEBHOOK_SECRET!
);
```

If you skip this, anyone who knows your URL can POST a fake "payment succeeded" and confirm bookings for free. The signature proves the request came from Stripe.

**The body must be raw.** Use `await req.text()`, not `req.json()`. Stripe signs the raw bytes; parsing first breaks verification.

### 2. Idempotency at two layers

**Layer 1: dedupe table.**

```ts
await supabase.from('processed_webhook_events').insert({ id: event.id });
```

If the insert fails with a unique violation (`23505`), the event was already processed — return 200 and exit. Stripe retries on non-2xx, so this is what stops a retry storm.

**Layer 2: `confirm_booking` is idempotent.**

Even if the dedupe table were bypassed, the second call to `confirm_booking` for the same booking sees `status = 'confirmed'` and returns early.

### 3. Refund-on-loss

```ts
if (post?.failure_reason === 'seat_taken_refund_pending') {
  await stripe.refunds.create({ payment_intent: pi.id, reason: 'duplicate' });
  await supabase.from('payment_attempts')
    .update({ status: 'refunded' })
    .eq('id', attemptId);
}
```

Stripe charged the loser even though they lost the seat. We can't un-charge them, so we refund. This is the direct cost of not holding seats at payment-selection time — see the tradeoff in the [README](../README.md#why-not-a-seat-hold).

### 4. Delete-on-error

```ts
try {
  // ... process event
  return NextResponse.json({ ok: true });
} catch (err) {
  await supabase.from('processed_webhook_events').delete().eq('id', event.id);
  return NextResponse.json({ error: err.message }, { status: 500 });
}
```

**This looks wrong but is deliberate.** If we inserted the dedupe row and then crashed before doing the work, we return 500. Stripe retries. If we *didn't* delete the dedupe row, the retry would hit the unique constraint, see `duplicate: true`, and be acked with a 200 — the work would never happen.

The alternative is to record the failure permanently and require manual intervention. That's safer against poisoning attacks but adds an ops surface. For a slice, delete-on-error is the right default; in production I'd probably record the failure and alert.

---

## Deploying to production

### 1. Deploy the app

Push to GitHub, import to Vercel, add the three env vars to the project. First build ~60s.

### 2. Configure the production webhook

Stripe Dashboard → **Developers → Webhooks** → **Add endpoint**.

- **URL:** `https://your-app.vercel.app/api/webhooks/stripe`
- **Events:** `payment_intent.succeeded`, `payment_intent.payment_failed`

Copy the signing secret → Vercel env var `STRIPE_WEBHOOK_SECRET` → **redeploy** (env var changes don't take effect on the existing deployment).

### 3. Verify

Stripe Dashboard → your endpoint → **Send test webhook** → `payment_intent.succeeded`. Expect 200. If you get 400 `bad_signature`, the secret didn't reload — redeploy.

---

## Production checklist

- [ ] `runtime = 'nodejs'` on the webhook route (Edge has no `crypto` for signature verification).
- [ ] Raw body via `req.text()`, not `req.json()`.
- [ ] `STRIPE_WEBHOOK_SECRET` set in Vercel for **Production, Preview, and Development**.
- [ ] `SUPABASE_SERVICE_ROLE_KEY` never imported into a client component. Verify with `grep -r "SERVICE_ROLE" .next/static` — should return nothing.
- [ ] Refund automation in place — the current handler refunds inline, but if Stripe's API is down, the refund is lost. A background job that retries is the production answer.
- [ ] Alerting on `payment_attempts.status = 'succeeded' and failure_reason = 'seat_taken_refund_pending'` older than 1 hour.
- [ ] Rate limiting on `/api/bookings` if you're worried about abuse.

---

## What changes for the last-seat race

**Nothing.** The whole point of routing both paths through `confirm_booking` is that the correctness argument is identical:

- The mock path calls `confirm_booking` from a `fetch()` to `/simulate`.
- The real path calls `confirm_booking` from a signed webhook.

Both go through the same `UPDATE ... WHERE confirmed_count < capacity`. Both mark the loser `payment_failed` with `seat_taken_refund_pending`. Both rely on the partial unique index for duplicate prevention.

**The mock path is a proxy for the real path, not a shortcut around it.** That's what makes the demo honest.

---

## Common pitfalls

| Symptom | Cause |
|---|---|
| `bad_signature` on every webhook | Wrong secret in `.env.local`, or body was parsed before verification |
| Webhook 200 but booking never confirmed | Event type not in the subscribed list, or `metadata.attempt_id` is missing |
| `duplicate: true` but booking still pending | Dedupe row inserted by a previous crash that didn't clean up — check `processed_webhook_events` |
| Refund issued but `payment_attempts.status` still `succeeded` | Refund call succeeded but the DB update failed — add a retry |
| `payment_intent.succeeded` arrives twice with different ids | Postgres retries with new event ids are rare but real; `confirm_booking` idempotency handles it |

---

## Summary

The real Stripe path is a thin wrapper around the same `confirm_booking` RPC the mock uses. The interesting work — seat grabbing, refund-on-loss, idempotency — is already done and tested. Stripe adds signature verification, event deduplication, and a real refund API call. For the take-home demo, the mock path is sufficient and faster to show; this document exists so a reviewer can see exactly how the production path would slot in.
