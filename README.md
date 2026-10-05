# Smart Faculty Queue & Appointment System

Node.js + Express REST API, SQLite (local) / PostgreSQL (production), vanilla JS frontend.
Passwords are hashed (bcrypt), sessions use JWT, business rules BR1–BR5 are enforced on the server
and with unique indexes in the database.

## Run locally (VS Code)
1. Install Node.js 18+ (https://nodejs.org).
2. Open this folder in VS Code, then in the terminal:
   ```
   npm install
   copy .env.example .env      (Mac/Linux: cp .env.example .env)
   npm start
   ```
3. Open http://localhost:3000. The database (`data.db`) is created and seeded automatically.
   Documentation and diagrams: http://localhost:3000/docs.html

## Test accounts (seeded)
| Role | Username | Password |
|---|---|---|
| Admin | admin | Admin123! |
| Faculty | faculty1 / faculty2 / faculty3 | Faculty123! |
| Student | student1 / student2 | Student123! |

## Publish publicly (Render + PostgreSQL, free tiers)
1. Push this folder to a GitHub repository (`.env` and `data.db` are git-ignored).
2. Render dashboard → New → **PostgreSQL** (free). Copy its *Internal Database URL*.
3. Render → New → **Web Service** → connect your repo.
   - Build command: `npm install`
   - Start command: `npm start`
   - Environment variables: `DATABASE_URL` = the URL from step 2, `JWT_SECRET` = a long random string.
4. Deploy. Your public URL looks like `https://your-app.onrender.com`.
   Tables and seed accounts are created automatically on first start.
   (Neon or Supabase PostgreSQL also work: just paste their connection string as `DATABASE_URL`.)

Notes: free Render services sleep after inactivity (first load can take ~30 s); free Render
PostgreSQL databases expire after a limited period, so check current terms before your defense.
Change the seeded passwords if the site stays public after the presentation.

## Structure
- `server.js` REST API + business rules · `db.js` schema, seed, SQLite/PostgreSQL adapter
- `public/index.html` app UI · `public/docs.html` analysis, requirements, rules, DFDs, ERD, test cases

## Test cases (see docs page for the full table)
TC1 valid login · TC2 wrong password · TC3 book free slot · TC4 same-time booking (BR2) ·
TC5 4th appointment (BR3) · TC6 duplicate ticket (BR4) · TC7 call next + complete with notes ·
TC8 deactivated user blocked · TC9 faculty search by department

## Existing PostgreSQL database? Run the migration once
Foreign keys on `appointments.slot_id` and `consultation_logs.*`, the "completed slots stay reserved" index and the
unique ticket-number index are created automatically on a NEW database. For the already-deployed one run, once:
```
npm run migrate        (needs DATABASE_URL in .env or the environment)
```
If a step prints FAILED because old demo rows violate it, delete those rows (or drop the tables and let the app reseed).
Local SQLite: delete `data.db` and restart.

## Database transactions
`db.tx(fn)` runs a callback on one connection with BEGIN / COMMIT / ROLLBACK. It wraps: book appointment,
join queue (ticket number + insert), call next, finish ticket (status + consultation log), complete appointment.

## Deployment information (fill in before submitting; never include secrets)
| Item | Value |
|---|---|
| Production URL | https://YOUR-APP.onrender.com |
| Technology stack | Node.js 18+, Express 4, bcryptjs, jsonwebtoken, pg, vanilla HTML/CSS/JS, Mermaid |
| Frontend hosting | Render Web Service (static files in `public/` served by Express) |
| Backend hosting | Render Web Service (Node.js) |
| Database service | Render PostgreSQL |
| Repository | https://github.com/YOU/REPO |
| Test accounts | see the table above |
Environment variables `DATABASE_URL` and `JWT_SECRET` are set in the Render dashboard only. Optional `TZ_NAME` (default `Asia/Manila`) sets the timezone used for "past date" checks.

## Security notes
- Passwords are stored as bcrypt hashes. `.env` is git-ignored and no secret is committed.
- With PostgreSQL / `NODE_ENV=production` the server refuses to start unless `JWT_SECRET` is set (no default secret online).
- Admin can edit users (name, department), reset a password to `Temp123!`, and deactivate accounts.
