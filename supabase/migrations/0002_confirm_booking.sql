create or replace function confirm_booking(p_booking_id uuid, p_payment_ref text)
returns bookings
language plpgsql
as $$
declare
  v_booking bookings;
  v_seated  uuid;
  v_existing uuid;
begin
  select * into v_booking from bookings where id = p_booking_id for update;
  if not found then raise exception 'booking_not_found'; end if;

  -- Idempotent: already confirmed.
  if v_booking.status = 'confirmed' then
    return v_booking;
  end if;

  if v_booking.status <> 'pending_payment' then
    raise exception 'booking_not_confirmable:%', v_booking.status;
  end if;

  -- Belt-and-braces: refuse if this student is already confirmed for this class.
  -- The partial unique index should prevent this from being reachable, but if
  -- the index is ever dropped or bypassed, we still don't double-book.
  select id into v_existing
    from bookings
   where student_id = v_booking.student_id
     and trial_class_id = v_booking.trial_class_id
     and status = 'confirmed'
     and id <> p_booking_id
   limit 1;

  if v_existing is not null then
    update bookings
       set status = 'payment_failed', updated_at = now()
     where id = p_booking_id
    returning * into v_booking;

    update payment_attempts
       set status = 'succeeded',
           provider_ref = p_payment_ref,
           failure_reason = 'duplicate_confirmed',
           updated_at = now()
     where booking_id = p_booking_id;

    return v_booking;
  end if;

  -- Atomic seat grab.
  update trial_classes
     set confirmed_count = confirmed_count + 1
   where id = v_booking.trial_class_id
     and confirmed_count < capacity
  returning id into v_seated;

  -- Lost the last-seat race.
  if v_seated is null then
    update bookings
       set status = 'payment_failed', updated_at = now()
     where id = p_booking_id
    returning * into v_booking;

    update payment_attempts
       set status = 'succeeded',
           provider_ref = p_payment_ref,
           failure_reason = 'seat_taken_refund_pending',
           updated_at = now()
     where booking_id = p_booking_id;

    return v_booking;
  end if;

  update bookings
     set status = 'confirmed', updated_at = now()
   where id = p_booking_id
  returning * into v_booking;

  update payment_attempts
     set status = 'succeeded',
         provider_ref = p_payment_ref,
         updated_at = now()
   where booking_id = p_booking_id;

  return v_booking;
end;
$$;
