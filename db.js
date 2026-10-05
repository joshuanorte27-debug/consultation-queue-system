require('dotenv').config();
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const PG = !!process.env.DATABASE_URL;
let all, run, tx;
const mkGet = (a) => async (s, p) => (await a(s, p))[0];

if (PG) {
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false },
  });
  const conv = (s) => { let i = 0; return s.replace(/\?/g, () => '$' + ++i); };
  all = async (s, p = []) => (await pool.query(conv(s), p)).rows;
  run = async (s, p = []) => { await pool.query(conv(s), p); };
  // Real transaction: one dedicated connection, BEGIN / COMMIT / ROLLBACK.
  tx = async (fn) => {
    const c = await pool.connect();
    const t = {
      all: async (s, p = []) => (await c.query(conv(s), p)).rows,
      run: async (s, p = []) => { await c.query(conv(s), p); },
    };
    t.get = mkGet(t.all);
    try { await c.query('BEGIN'); const r = await fn(t); await c.query('COMMIT'); return r; }
    catch (e) { try { await c.query('ROLLBACK'); } catch {} throw e; }
    finally { c.release(); }
  };
} else {
  const Database = require('better-sqlite3');
  const d = new Database(process.env.SQLITE_PATH || './data.db');
  d.pragma('journal_mode = WAL');
  d.pragma('foreign_keys = ON');
  const rawAll = (s, p = []) => d.prepare(s).all(...p);
  const rawRun = (s, p = []) => { d.prepare(s).run(...p); };
  // One connection is shared, so a queue keeps other requests out of an open transaction.
  let q = Promise.resolve();
  const lock = (fn) => { const p = q.then(fn); q = p.catch(() => {}); return p; };
  all = (s, p) => lock(async () => rawAll(s, p));
  run = (s, p) => lock(async () => rawRun(s, p));
  tx = (fn) => lock(async () => {
    const t = { all: async (s, p) => rawAll(s, p), run: async (s, p) => rawRun(s, p) };
    t.get = mkGet(t.all);
    rawRun('BEGIN');
    try { const r = await fn(t); rawRun('COMMIT'); return r; }
    catch (e) { rawRun('ROLLBACK'); throw e; }
  });
}
const get = mkGet(all);
const isUnique = (e) => e && (e.code === '23505' || e.code === 'SQLITE_CONSTRAINT_UNIQUE' || e.code === 'SQLITE_CONSTRAINT_PRIMARYKEY' || /UNIQUE constraint failed/.test(e.message || ''));
const id = () => crypto.randomUUID();
const ts = () => new Date().toISOString();

// One schema that works on both SQLite and PostgreSQL (TEXT ids, INTEGER flags).
const SCHEMA = [
`CREATE TABLE IF NOT EXISTS users(
  id TEXT PRIMARY KEY, full_name TEXT NOT NULL, username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('student','faculty','admin')),
  active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL)`,
`CREATE TABLE IF NOT EXISTS faculty_profiles(
  user_id TEXT PRIMARY KEY REFERENCES users(id), department TEXT NOT NULL,
  queue_open INTEGER NOT NULL DEFAULT 1)`,
`CREATE TABLE IF NOT EXISTS faculty_schedules(
  id TEXT PRIMARY KEY, faculty_id TEXT NOT NULL REFERENCES users(id),
  slot_date TEXT NOT NULL, slot_time TEXT NOT NULL, UNIQUE(faculty_id, slot_date, slot_time))`,
`CREATE TABLE IF NOT EXISTS appointments(
  id TEXT PRIMARY KEY, student_id TEXT NOT NULL REFERENCES users(id),
  faculty_id TEXT NOT NULL REFERENCES users(id), slot_id TEXT NOT NULL REFERENCES faculty_schedules(id),
  topic TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'booked', created_at TEXT NOT NULL)`,
`CREATE TABLE IF NOT EXISTS queue_tickets(
  id TEXT PRIMARY KEY, ticket_no TEXT NOT NULL, student_id TEXT NOT NULL REFERENCES users(id),
  faculty_id TEXT NOT NULL REFERENCES users(id), topic TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'waiting', created_at TEXT NOT NULL)`,
`CREATE TABLE IF NOT EXISTS consultation_logs(
  id TEXT PRIMARY KEY, appt_id TEXT REFERENCES appointments(id), ticket_id TEXT REFERENCES queue_tickets(id),
  faculty_id TEXT NOT NULL REFERENCES users(id), student_id TEXT NOT NULL REFERENCES users(id),
  ref_no TEXT, topic TEXT, notes TEXT, logged_at TEXT NOT NULL)`,
`CREATE TABLE IF NOT EXISTS audit_logs(
  id TEXT PRIMARY KEY, username TEXT, action TEXT NOT NULL, created_at TEXT NOT NULL)`,
// Database-level enforcement of the business rules (also safe against race conditions):
`CREATE UNIQUE INDEX IF NOT EXISTS uq_slot_booked ON appointments(slot_id) WHERE status IN ('booked','completed')`,
`CREATE UNIQUE INDEX IF NOT EXISTS uq_active_ticket ON queue_tickets(student_id, faculty_id) WHERE status IN ('waiting','serving')`,
`CREATE UNIQUE INDEX IF NOT EXISTS uq_one_serving ON queue_tickets(faculty_id) WHERE status='serving'`,
`CREATE UNIQUE INDEX IF NOT EXISTS uq_ticket_no ON queue_tickets(ticket_no)`,
];

async function seed() {
  const hash = (p) => bcrypt.hashSync(p, 10);
  const mk = async (name, user, role, pw, dept) => {
    const uid = id();
    await run('INSERT INTO users(id,full_name,username,password_hash,role,active,created_at) VALUES(?,?,?,?,?,1,?)', [uid, name, user, hash(pw), role, ts()]);
    if (role === 'faculty') await run('INSERT INTO faculty_profiles(user_id,department,queue_open) VALUES(?,?,?)', [uid, dept, dept === 'Information Systems' ? 0 : 1]);
    return uid;
  };
  await mk('Admin Ada', 'admin', 'admin', 'Admin123!');
  const f1 = await mk('Dr. Maria Santos', 'faculty1', 'faculty', 'Faculty123!', 'Computer Science');
  const f2 = await mk('Prof. Jose Reyes', 'faculty2', 'faculty', 'Faculty123!', 'Mathematics');
  const f3 = await mk('Dr. Ana Cruz', 'faculty3', 'faculty', 'Faculty123!', 'Information Systems');
  const s1 = await mk('Student Ben', 'student1', 'student', 'Student123!');
  const s2 = await mk('Student Carla', 'student2', 'student', 'Student123!');
  const first = {};
  for (const f of [f1, f2, f3]) for (let d = 1; d <= 3; d++) {
    const date = new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);
    for (const t of ['09:00', '09:30', '10:00', '13:00', '13:30', '14:00']) {
      const sid = id(); first[f] = first[f] || sid;
      await run('INSERT INTO faculty_schedules(id,faculty_id,slot_date,slot_time) VALUES(?,?,?,?)', [sid, f, date, t]);
    }
  }
  await run('INSERT INTO appointments(id,student_id,faculty_id,slot_id,topic,status,created_at) VALUES(?,?,?,?,?,?,?)', [id(), s1, f1, first[f1], 'Capstone consultation', 'booked', ts()]);
  await run('INSERT INTO queue_tickets(id,ticket_no,student_id,faculty_id,topic,status,created_at) VALUES(?,?,?,?,?,?,?)', [id(), 'Q-001', s1, f1, 'Walk-in: grade query', 'waiting', ts()]);
  await run('INSERT INTO queue_tickets(id,ticket_no,student_id,faculty_id,topic,status,created_at) VALUES(?,?,?,?,?,?,?)', [id(), 'Q-002', s2, f1, 'Walk-in: advising', 'waiting', ts()]);
  await run('INSERT INTO audit_logs(id,username,action,created_at) VALUES(?,?,?,?)', [id(), 'system', 'Database seeded', ts()]);
}

async function init() {
  for (const s of SCHEMA) await run(s);
  const c = await get('SELECT COUNT(*) AS c FROM users');
  if (Number(c.c) === 0) await seed();
}
module.exports = { all, run, get, tx, isUnique, id, ts, init, PG };
