// One-time migration for an EXISTING PostgreSQL database (new installs get this from db.js automatically).
// Usage: set DATABASE_URL (e.g. in .env) then run:  npm run migrate
require('dotenv').config();
if (!process.env.DATABASE_URL) { console.error('Set DATABASE_URL first.'); process.exit(1); }
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false } });
const STEPS = [
  ['FK appointments.slot_id -> faculty_schedules', 'ALTER TABLE appointments ADD CONSTRAINT fk_appt_slot FOREIGN KEY (slot_id) REFERENCES faculty_schedules(id)'],
  ['FK consultation_logs.appt_id -> appointments', 'ALTER TABLE consultation_logs ADD CONSTRAINT fk_log_appt FOREIGN KEY (appt_id) REFERENCES appointments(id)'],
  ['FK consultation_logs.ticket_id -> queue_tickets', 'ALTER TABLE consultation_logs ADD CONSTRAINT fk_log_ticket FOREIGN KEY (ticket_id) REFERENCES queue_tickets(id)'],
  ['FK consultation_logs.faculty_id -> users', 'ALTER TABLE consultation_logs ADD CONSTRAINT fk_log_faculty FOREIGN KEY (faculty_id) REFERENCES users(id)'],
  ['FK consultation_logs.student_id -> users', 'ALTER TABLE consultation_logs ADD CONSTRAINT fk_log_student FOREIGN KEY (student_id) REFERENCES users(id)'],
  ['Index: completed slots stay reserved', 'DROP INDEX IF EXISTS uq_slot_booked'],
  ['Index: completed slots stay reserved', "CREATE UNIQUE INDEX uq_slot_booked ON appointments(slot_id) WHERE status IN ('booked','completed')"],
  ['Index: unique ticket numbers', 'CREATE UNIQUE INDEX IF NOT EXISTS uq_ticket_no ON queue_tickets(ticket_no)'],
];
(async () => {
  for (const [label, sql] of STEPS) {
    try { await pool.query(sql); console.log('OK    ', label); }
    catch (e) { console.log(e.code === '42710' || e.code === '42P07' ? 'EXISTS' : 'FAILED', label, '-', e.message); }
  }
  await pool.end();
})();
