Tools: Claude (chat) for design review and Postgres reasoning; Cursor for boilerplate Next.js routes.

What I used AI for: brainstorming the seat-grab approaches; drafting the Vitest scaffold; double-checking pg error codes and Supabase rpc return shape.

Where AI moved me fast: the first version I got back used SELECT count(*) ... then INSERT. Swapping to the single-statement UPDATE ... WHERE confirmed_count < capacity and reasoning about which writer wins was a five-minute conversation that would have taken me longer to lay out on paper.

Where I disagreed / corrected AI: an earlier suggestion proposed SERIALIZABLE isolation and a retry loop for the whole booking flow. That's overkill for a 4-hour slice and adds failure modes (retries, dedup). I replaced it with the targeted atomic UPDATE. Also, AI suggested reserving a seat at selection time — I rejected it because the prompt's own scenario requires two users to reach payment for the last seat, which a reservation would prevent.

What I'd change next time: prompt with the schema first and ask the model to critique it, rather than asking it to produce both schema and code in one shot. Schema critiques were higher-signal than code.

How I verified: ran the Vitest suite (PGlite); manually exercised /book and the roster; re-read confirm_booking line-by-line for the "lose the race → mark failed, record payment, flag refund" branch, which is the easiest place to accidentally confirm a booking you shouldn't.
