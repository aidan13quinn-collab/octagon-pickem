# Octagon Pick'em

A UFC pick'em league for friends. Everyone picks a winner in every fight on the card and marks one pick per week as their lock. Standings show each player's pick record and lock record.

- **Site:** plain HTML, CSS and JavaScript, no build step. Vercel serves the folder as-is.
- **Database and sign-in:** Supabase (`config.js` holds the public project URL and anon key; row-level security in the database decides who can read and write what).
- **Cards and results:** added automatically by scheduled tasks that write to the `cards` table.

## Rules enforced by the database
- Players can only create or change their own picks and lock.
- Picks and locks can't be changed once a card's `lock_at` time passes.
- Other players' picks stay hidden until the card locks.
