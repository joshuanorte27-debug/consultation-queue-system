require('dotenv').config();
const path = require('path');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./db');

// Production (PostgreSQL / NODE_ENV=production) refuses to start without a real secret, so no default secret is ever used online.
if (!process.env.JWT_SECRET && (process.env.DATABASE_URL || process.env.NODE_ENV === 'production')) { console.error('FATAL: set JWT_SECRET in the environment.'); process.exit(1); }
const SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
if (!process.env.JWT_SECRET) console.warn('WARNING: using the local development JWT secret.');
const app = express();
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const bad = (m, s = 400) => { const e = new Error(m); e.status = s; throw e; };
const h = (fn) => (req, res) => fn(req, res).catch((e) => {
  if (e.status) return res.status(e.status).json({ error: e.message });
  console.error(e); res.status(500).json({ error: 'Server error' });
});
const audit = (req, action) => db.run('INSERT INTO audit_logs(id,username,action,created_at) VALUES(?,?,?,?)', [db.id(), req.user ? req.user.username : '-', action, db.ts()]);
const short = (t) => String(t).slice(0, 16).replace('T', ' ');
const clean = (s, n = 120) => String(s || '').trim().slice(0, n);

// Auth middleware: verifies the JWT, reloads the user, checks role + active flag.
const auth = (...roles) => async (req, res, next) => {
  try {
    const t = (req.headers.authorization || '').replace('Bearer ', '');
    let p; try { p = jwt.verify(t, SECRET); } catch { bad('Unauthorized', 401); }
    const u = await db.get('SELECT id, full_name AS name, username, role, active FROM users WHERE id=?', [p.id]);
    if (!u || !Number(u.active)) bad('Unauthorized', 401);
    if (roles.length && !roles.includes(u.role)) bad('Forbidden', 403);
    req.user = u; next();
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
};

// ---------- Auth (FR1) ----------
app.post('/api/login', h(async (req, res) => {
  const u = await db.get('SELECT * FROM users WHERE username=?', [clean(req.body.user, 50)]);
  if (!u || !bcrypt.compareSync(String(req.body.pw || ''), u.password_hash)) bad('Invalid credentials.', 401);
  if (!Number(u.active)) bad('Account deactivated.', 403);
  req.user = u; await audit(req, 'Login');
  res.json({ token: jwt.sign({ id: u.id }, SECRET, { expiresIn: '12h' }) });
}));
app.post('/api/register', h(async (req, res) => {
  const name = clean(req.body.name, 80), user = clean(req.body.user, 50), pw = String(req.body.pw || '');
  if (!name || !user || pw.length < 6) bad('Name, username and 6+ char password required.');
  if (await db.get('SELECT 1 AS x FROM users WHERE username=?', [user])) bad('Username taken.', 409);
  await db.run('INSERT INTO users(id,full_name,username,password_hash,role,active,created_at) VALUES(?,?,?,?,?,1,?)', [db.id(), name, user, bcrypt.hashSync(pw, 10), 'student', db.ts()]);
  res.json({ ok: true });
}));

// ---------- Role-scoped state for the dashboard (FR11) ----------
app.get('/api/state', auth(), h(async (req, res) => {
  const me = req.user, role = me.role;
  const [users, slots, appts, tickets, logs] = await Promise.all([
    db.all('SELECT u.id, u.full_name AS name, u.role, u.username AS "user", u.active, f.department AS dept, f.queue_open AS "open" FROM users u LEFT JOIN faculty_profiles f ON f.user_id=u.id'),
    db.all('SELECT s.id, s.faculty_id AS fid, s.slot_date AS date, s.slot_time AS time, EXISTS(SELECT 1 FROM appointments a WHERE a.slot_id=s.id AND a.status IN (\'booked\',\'completed\')) AS taken FROM faculty_schedules s'),
    db.all('SELECT id, student_id AS sid, faculty_id AS fid, slot_id AS slot, topic, status, created_at FROM appointments ORDER BY created_at'),
    db.all('SELECT id, ticket_no AS no, student_id AS sid, faculty_id AS fid, topic, status, created_at FROM queue_tickets ORDER BY created_at, ticket_no'),
    db.all('SELECT id, faculty_id AS fid, student_id AS sid, ref_no AS no, topic, notes AS note, logged_at FROM consultation_logs ORDER BY logged_at DESC'),
  ]);
  const wq = {}, posMap = {};
  tickets.filter((t) => t.status === 'waiting').forEach((t) => { wq[t.fid] = (wq[t.fid] || 0) + 1; posMap[t.id] = wq[t.fid]; });
  const own = (x) => role === 'admin' || (role === 'student' ? x.sid === me.id : x.fid === me.id);
  const A_ = appts.filter(own).map((a) => ({ ...a, at: short(a.created_at) }));
  const T_ = tickets.filter(own).map((t) => ({ ...t, at: short(t.created_at), pos: posMap[t.id] || 0 }));
  const L_ = logs.filter(own).map((l) => ({ ...l, at: short(l.logged_at) }));
  const need = new Set([me.id]); [...A_, ...T_, ...L_].forEach((x) => { need.add(x.sid); need.add(x.fid); });
  const U = users.filter((u) => role === 'admin' || (u.role === 'faculty' && Number(u.active)) || need.has(u.id))
    .map((u) => ({ id: u.id, name: u.name, role: u.role, user: u.user, active: Number(u.active), dept: u.dept, open: Number(u.open), wq: wq[u.id] || 0 }));
  const out = {
    me: U.find((u) => u.id === me.id) || { id: me.id, name: me.name, role },
    users: U, appts: A_, tickets: T_, logs: L_,
    slots: (role === 'faculty' ? slots.filter((s) => s.fid === me.id) : slots).map((s) => ({ ...s, taken: !!Number(s.taken) || s.taken === true })),
    audit: [],
  };
  if (role === 'admin') out.audit = (await db.all('SELECT created_at, username AS who, action AS act FROM audit_logs ORDER BY created_at DESC LIMIT 100')).map((a) => ({ ...a, at: short(a.created_at) }));
  res.json(out);
}));

// ---------- Student: booking + queue (FR4-FR6, FR9; BR1-BR4, BR6) ----------
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: process.env.TZ_NAME || 'Asia/Manila' });
const BR4 = 'BR4: You already hold an active ticket for this faculty.';

// Booking runs in ONE database transaction (check + insert); the unique index covers races.
app.post('/api/appointments', auth('student'), h(async (req, res) => {
  const topic = clean(req.body.topic, 200); if (!topic) bad('Enter a topic.');
  try {
    await db.tx(async (t) => {
      const s = await t.get('SELECT * FROM faculty_schedules WHERE id=?', [req.body.slotId]); if (!s) bad('Slot not found.', 404);
      if (s.slot_date < today()) bad('BR6: Cannot book a past date.');
      if (await t.get("SELECT 1 AS x FROM appointments WHERE slot_id=? AND status IN ('booked','completed')", [s.id])) bad('BR1: Slot already booked.', 409);
      const mine = await t.all("SELECT s.slot_date, s.slot_time FROM appointments a JOIN faculty_schedules s ON s.id=a.slot_id WHERE a.student_id=? AND a.status='booked'", [req.user.id]);
      if (mine.some((x) => x.slot_date === s.slot_date && x.slot_time === s.slot_time)) bad('BR2: You already have an appointment at that time.', 409);
      if (mine.length >= 3) bad('BR3: Maximum 3 active appointments.', 409);
      await t.run('INSERT INTO appointments(id,student_id,faculty_id,slot_id,topic,status,created_at) VALUES(?,?,?,?,?,?,?)', [db.id(), req.user.id, s.faculty_id, s.id, topic, 'booked', db.ts()]);
    });
  } catch (e) { if (db.isUnique(e)) bad('BR1: Slot already booked.', 409); throw e; }
  await audit(req, 'Booked appointment'); res.json({ ok: true });
}));

// Joining the queue: rule checks, ticket-number generation and insert in one transaction.
// A unique-index collision (two students at once) is retried so ticket numbers never repeat.
app.post('/api/queue', auth('student'), h(async (req, res) => {
  const fid = req.body.facultyId;
  for (let i = 0; i < 4; i++) {
    try {
      await db.tx(async (t) => {
        const f = await t.get('SELECT p.queue_open FROM faculty_profiles p JOIN users u ON u.id=p.user_id WHERE p.user_id=? AND u.active=1', [fid]);
        if (!f) bad('Faculty not found.', 404);
        if (!Number(f.queue_open)) bad('Faculty queue is closed.', 409);
        if (await t.get("SELECT 1 AS x FROM queue_tickets WHERE student_id=? AND faculty_id=? AND status IN ('waiting','serving')", [req.user.id, fid])) bad(BR4, 409);
        const n = Number((await t.get('SELECT COUNT(*) AS c FROM queue_tickets')).c) + 1;
        await t.run('INSERT INTO queue_tickets(id,ticket_no,student_id,faculty_id,topic,status,created_at) VALUES(?,?,?,?,?,?,?)',
          [db.id(), 'Q-' + String(n).padStart(3, '0'), req.user.id, fid, 'Walk-in: ' + (clean(req.body.topic, 150) || 'consultation'), 'waiting', db.ts()]);
      });
      break;
    } catch (e) { if (!db.isUnique(e)) throw e; if (i === 3) bad(BR4, 409); }
  }
  await audit(req, 'Joined queue'); res.json({ ok: true });
}));
app.post('/api/appointments/:id/cancel', auth('student', 'faculty'), h(async (req, res) => {
  const col = req.user.role === 'student' ? 'student_id' : 'faculty_id';
  const a = await db.get(`SELECT id FROM appointments WHERE id=? AND ${col}=? AND status='booked'`, [req.params.id, req.user.id]);
  if (!a) bad('Appointment not found or already closed.', 404);
  await db.run("UPDATE appointments SET status='cancelled' WHERE id=?", [a.id]);
  await audit(req, 'Cancelled appointment'); res.json({ ok: true });
}));
app.post('/api/tickets/:id/cancel', auth('student'), h(async (req, res) => {
  const k = await db.get("SELECT id FROM queue_tickets WHERE id=? AND student_id=? AND status='waiting'", [req.params.id, req.user.id]);
  if (!k) bad('Ticket not found or already closed.', 404);
  await db.run("UPDATE queue_tickets SET status='cancelled' WHERE id=?", [k.id]);
  await audit(req, 'Left queue'); res.json({ ok: true });
}));

// ---------- Faculty: availability + session workflow (FR2, FR7, FR8; BR5, BR6) ----------
app.post('/api/slots', auth('faculty'), h(async (req, res) => {
  const d = clean(req.body.date, 10), t = clean(req.body.time, 5);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !/^\d{2}:\d{2}$/.test(t)) bad('Pick a valid date and time.');
  if (d < today()) bad('BR6: Cannot add slots in the past.');
  if (await db.get('SELECT 1 AS x FROM faculty_schedules WHERE faculty_id=? AND slot_date=? AND slot_time=?', [req.user.id, d, t])) bad('Slot already exists.', 409);
  await db.run('INSERT INTO faculty_schedules(id,faculty_id,slot_date,slot_time) VALUES(?,?,?,?)', [db.id(), req.user.id, d, t]);
  await audit(req, 'Added slot'); res.json({ ok: true });
}));
app.delete('/api/slots/:id', auth('faculty'), h(async (req, res) => {
  if (await db.get('SELECT 1 AS x FROM appointments WHERE slot_id=?', [req.params.id])) bad('BR5: Slot has booking history; it cannot be removed.', 409);
  await db.run('DELETE FROM faculty_schedules WHERE id=? AND faculty_id=?', [req.params.id, req.user.id]);
  await audit(req, 'Removed slot'); res.json({ ok: true });
}));
app.post('/api/queue/open', auth('faculty'), h(async (req, res) => {
  await db.run('UPDATE faculty_profiles SET queue_open=? WHERE user_id=?', [req.body.open ? 1 : 0, req.user.id]);
  await audit(req, 'Queue toggled'); res.json({ ok: true });
}));
app.post('/api/queue/call', auth('faculty'), h(async (req, res) => {
  let no;
  try {
    await db.tx(async (t) => {
      if (await t.get("SELECT 1 AS x FROM queue_tickets WHERE faculty_id=? AND status='serving'", [req.user.id])) bad('Finish the current session first.', 409);
      const k = await t.get("SELECT id, ticket_no FROM queue_tickets WHERE faculty_id=? AND status='waiting' ORDER BY created_at, ticket_no LIMIT 1", [req.user.id]);
      if (!k) bad('Queue empty.', 409);
      await t.run("UPDATE queue_tickets SET status='serving' WHERE id=?", [k.id]); no = k.ticket_no;
    });
  } catch (e) { if (db.isUnique(e)) bad('Finish the current session first.', 409); throw e; }
  await audit(req, 'Called ' + no); res.json({ ok: true });
}));
// Finishing a ticket: status update + consultation log are ONE transaction (both happen or neither).
app.post('/api/tickets/:id/finish', auth('faculty'), h(async (req, res) => {
  const st = req.body.status === 'noshow' ? 'noshow' : 'completed'; let no;
  await db.tx(async (t) => {
    const k = await t.get("SELECT * FROM queue_tickets WHERE id=? AND faculty_id=? AND status='serving'", [req.params.id, req.user.id]);
    if (!k) bad('Ticket is not being served.', 409);
    await t.run('UPDATE queue_tickets SET status=? WHERE id=?', [st, k.id]);
    if (st === 'completed') await t.run('INSERT INTO consultation_logs(id,ticket_id,faculty_id,student_id,ref_no,topic,notes,logged_at) VALUES(?,?,?,?,?,?,?,?)',
      [db.id(), k.id, k.faculty_id, k.student_id, k.ticket_no, k.topic, clean(req.body.note, 500) || '(no notes)', db.ts()]);
    no = k.ticket_no;
  });
  await audit(req, st + ' ' + no); res.json({ ok: true });
}));
app.post('/api/appointments/:id/complete', auth('faculty'), h(async (req, res) => {
  await db.tx(async (t) => {
    const a = await t.get("SELECT * FROM appointments WHERE id=? AND faculty_id=? AND status='booked'", [req.params.id, req.user.id]);
    if (!a) bad('Appointment not found.', 404);
    await t.run("UPDATE appointments SET status='completed' WHERE id=?", [a.id]);
    await t.run('INSERT INTO consultation_logs(id,appt_id,faculty_id,student_id,ref_no,topic,notes,logged_at) VALUES(?,?,?,?,?,?,?,?)',
      [db.id(), a.id, a.faculty_id, a.student_id, 'APT', a.topic, clean(req.body.note, 500) || '(no notes)', db.ts()]);
  });
  await audit(req, 'Appointment completed'); res.json({ ok: true });
}));

// ---------- Admin: user management (FR10) ----------
app.post('/api/users', auth('admin'), h(async (req, res) => {
  const name = clean(req.body.name, 80), user = clean(req.body.user, 50), role = req.body.role === 'faculty' ? 'faculty' : 'student';
  if (!name || !user) bad('Name/username required.');
  if (await db.get('SELECT 1 AS x FROM users WHERE username=?', [user])) bad('Username taken.', 409);
  const uid = db.id();
  await db.run('INSERT INTO users(id,full_name,username,password_hash,role,active,created_at) VALUES(?,?,?,?,?,1,?)', [uid, name, user, bcrypt.hashSync('Temp123!', 10), role, db.ts()]);
  if (role === 'faculty') await db.run('INSERT INTO faculty_profiles(user_id,department,queue_open) VALUES(?,?,1)', [uid, 'General']);
  await audit(req, 'Created user ' + user); res.json({ ok: true });
}));
app.post('/api/users/:id/toggle', auth('admin'), h(async (req, res) => {
  if (req.params.id === req.user.id) bad('Cannot deactivate yourself.');
  await db.run('UPDATE users SET active = 1 - active WHERE id=?', [req.params.id]);
  await audit(req, 'Toggled user'); res.json({ ok: true });
}));

app.post('/api/users/:id/update', auth('admin'), h(async (req, res) => {
  const name = clean(req.body.name, 80), dept = clean(req.body.dept, 60);
  const u = await db.get('SELECT id, role FROM users WHERE id=?', [req.params.id]); if (!u) bad('User not found.', 404);
  if (!name) bad('Name required.');
  await db.run('UPDATE users SET full_name=? WHERE id=?', [name, u.id]);
  if (u.role === 'faculty' && dept) await db.run('UPDATE faculty_profiles SET department=? WHERE user_id=?', [dept, u.id]);
  await audit(req, 'Edited user'); res.json({ ok: true });
}));
app.post('/api/users/:id/reset', auth('admin'), h(async (req, res) => {
  const u = await db.get('SELECT id FROM users WHERE id=?', [req.params.id]); if (!u) bad('User not found.', 404);
  await db.run('UPDATE users SET password_hash=? WHERE id=?', [bcrypt.hashSync('Temp123!', 10), u.id]);
  await audit(req, 'Reset password'); res.json({ ok: true });
}));
app.get('/health', (_q, r) => r.send('ok'));
const PORT = process.env.PORT || 3000;
db.init().then(() => app.listen(PORT, () => console.log(`SFQAS running on http://localhost:${PORT} (${db.PG ? 'PostgreSQL' : 'SQLite'})`)))
  .catch((e) => { console.error('DB init failed:', e); process.exit(1); });
