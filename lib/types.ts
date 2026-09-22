export type BookingStatus = 'pending_payment' | 'confirmed' | 'payment_failed' | 'cancelled';
export type PaymentStatus = 'initiated' | 'succeeded' | 'failed' | 'refunded';

export interface Parent { id: string; name: string; email: string; }
export interface Student { id: string; parent_id: string; name: string; }
export interface TrialClass {
  id: string; subject: string; starts_at: string;
  capacity: number; confirmed_count: number;
}
export interface Booking {
  id: string; student_id: string; trial_class_id: string;
  status: BookingStatus; created_at: string; updated_at: string;
}
export interface PaymentAttempt {
  id: string; booking_id: string; status: PaymentStatus;
  provider_ref: string | null; failure_reason: string | null;
}
