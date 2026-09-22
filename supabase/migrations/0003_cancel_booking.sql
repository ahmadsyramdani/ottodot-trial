create or replace function cancel_booking(p_booking_id uuid, p_reason text default null)
returns bookings
language plpgsql
as $$
declare
  v_booking bookings;
begin
  select * into v_booking from bookings where id = p_booking_id for update;
  if not found then raise exception 'booking_not_found'; end if;

  if v_booking.status = 'cancelled' then
    return v_booking;
  end if;

  if v_booking.status = 'confirmed' then
    -- Free the seat.
    update trial_classes
       set confirmed_count = greatest(confirmed_count - 1, 0)
     where id = v_booking.trial_class_id;
  end if;

  update bookings
     set status = 'cancelled', updated_at = now()
   where id = p_booking_id
  returning * into v_booking;

  update payment_attempts
     set failure_reason = coalesce(p_reason, failure_reason),
         updated_at = now()
   where booking_id = p_booking_id;

  return v_booking;
end;
$$;
