-- =========================
-- Trial Booking: schema
-- =========================

create extension if not exists "pgcrypto";

create table parents (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null unique
);

create table students (
  id uuid primary key default gen_random_uuid(),
  parent_id uuid not null references parents(id) on delete cascade,
  name text not null
);
create index on students(parent_id);

create table trial_classes (
  id uuid primary key default gen_random_uuid(),
  subject text not null,
  starts_at timestamptz not null,
  capacity int not null default 4,
  confirmed_count int not null default 0,
  constraint capacity_bounds check (confirmed_count >= 0 and confirmed_count <= capacity)
);

do $$ begin
  create type booking_status as enum
    ('pending_payment','confirmed','payment_failed','cancelled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type payment_status as enum
    ('initiated','succeeded','failed','refunded');
exception when duplicate_object then null; end $$;

create table bookings (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references students(id),
  trial_class_id uuid not null references trial_classes(id),
  status booking_status not null default 'pending_payment',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One active booking per (student, class): either pending_payment or confirmed.
create unique index bookings_unique_active
  on bookings(student_id, trial_class_id)
  where status in ('pending_payment', 'confirmed');

create index bookings_by_class on bookings(trial_class_id) where status = 'confirmed';

create table payment_attempts (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references bookings(id) on delete cascade,
  status payment_status not null default 'initiated',
  provider_ref text unique,             -- PSP payment intent id
  failure_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on payment_attempts(booking_id);

-- Webhook idempotency: one row per PSP event id
create table processed_webhook_events (
  id text primary key,                  -- PSP event id
  received_at timestamptz not null default now()
);
