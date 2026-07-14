require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
app.use(cors());
app.use(express.json({ limit: '15mb' })); // homework attachments are base64 images/PDFs

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;
const DATABASE_URL = process.env.DATABASE_URL;

if (!JWT_SECRET) {
  console.error('Missing JWT_SECRET env var. Set it before starting the server.');
  process.exit(1);
}
if (!DATABASE_URL) {
  console.error('Missing DATABASE_URL env var. Set it to your Neon connection string.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // Neon requires SSL
});

// Keys that are allowed to move through the generic kv_store endpoints,
// and who's allowed to write each one.
const ADMIN_ONLY_KEYS = ['batches', 'attendance', 'homework', 'students', 'settings'];
const SHARED_WRITE_KEYS = ['fees', 'homeworkStatus']; // students can write here too

/* ============================================================
   STARTUP: make sure tables exist + seed default admin login
   ============================================================ */
async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS kv_store (
      key   TEXT PRIMARY KEY,
      value JSONB NOT NULL DEFAULT '{}'::jsonb
    );
    CREATE TABLE IF NOT EXISTS admin_auth (
      id            INT PRIMARY KEY DEFAULT 1,
      username      TEXT NOT NULL,
      password_hash TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS student_auth (
      student_id    TEXT PRIMARY KEY,
      username      TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL
    );
  `);

  const defaults = [
    ['settings', { instituteName: 'Ledger Tuition Center' }],
    ['students', []],
    ['batches', []],
    ['attendance', {}],
    ['fees', []],
    ['homework', []],
    ['homeworkStatus', {}],
  ];
  for (const [key, value] of defaults) {
    await pool.query(
      `INSERT INTO kv_store (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO NOTHING`,
      [key, JSON.stringify(value)]
    );
  }

  const { rows } = await pool.query('SELECT 1 FROM admin_auth WHERE id = 1');
  if (rows.length === 0) {
    const hash = await bcrypt.hash('admin123', 10);
    await pool.query(
      'INSERT INTO admin_auth (id, username, password_hash) VALUES (1, $1, $2)',
      ['admin', hash]
    );
    console.log('Seeded default admin login: admin / admin123 — change this after first login.');
  }
}

/* ============================================================
   AUTH MIDDLEWARE
   ============================================================ */
function auth(requiredRole) {
  return (req, res, next) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Missing token' });
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      req.user = payload; // { role: 'admin' } or { role: 'student', id, username }
      if (requiredRole && payload.role !== requiredRole) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      next();
    } catch (e) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
  };
}

function uid(prefix) {
  return prefix + '_' + Math.random().toString(36).slice(2, 9);
}

function uniqueUsernameSQL(students, base) {
  let u = String(base || 'student').trim() || 'student';
  let candidate = u, n = 1;
  const taken = new Set(students.map(s => s.username));
  while (taken.has(candidate)) { n++; candidate = u + n; }
  return candidate;
}

async function getKV(key) {
  const { rows } = await pool.query('SELECT value FROM kv_store WHERE key = $1', [key]);
  return rows.length ? rows[0].value : null;
}
async function setKV(key, value) {
  await pool.query(
    `INSERT INTO kv_store (key, value) VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = $2::jsonb`,
    [key, JSON.stringify(value)]
  );
}

/* ============================================================
   LOGIN
   ============================================================ */
app.post('/api/login', async (req, res) => {
  const { role, username, password } = req.body || {};
  if (!role || !username || !password) return res.status(400).json({ error: 'Missing fields' });

  try {
    if (role === 'admin') {
      const { rows } = await pool.query('SELECT * FROM admin_auth WHERE id = 1');
      const admin = rows[0];
      if (!admin || admin.username !== username) return res.status(401).json({ error: 'Incorrect username or password.' });
      const ok = await bcrypt.compare(password, admin.password_hash);
      if (!ok) return res.status(401).json({ error: 'Incorrect username or password.' });
      const token = jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '30d' });
      return res.json({ token, role: 'admin' });
    } else if (role === 'student') {
      const { rows } = await pool.query('SELECT * FROM student_auth WHERE username = $1', [username]);
      const rec = rows[0];
      if (!rec) return res.status(401).json({ error: 'Incorrect username or password.' });
      const ok = await bcrypt.compare(password, rec.password_hash);
      if (!ok) return res.status(401).json({ error: 'Incorrect username or password.' });
      const token = jwt.sign({ role: 'student', id: rec.student_id, username }, JWT_SECRET, { expiresIn: '30d' });
      return res.json({ token, role: 'student', id: rec.student_id });
    }
    return res.status(400).json({ error: 'Invalid role' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

/* ============================================================
   GENERIC DATA READ (both roles)
   ============================================================ */
app.get('/api/data', auth(), async (req, res) => {
  try {
    const keys = ['settings', 'students', 'batches', 'attendance', 'fees', 'homework', 'homeworkStatus'];
    const out = {};
    for (const k of keys) out[k] = await getKV(k);
    if (req.user.role === 'admin') {
      // Admin UI shows the current admin username in Settings; it lives in
      // admin_auth (not kv_store) since it's managed via a dedicated,
      // password-verified endpoint. Never attach the password hash here.
      const { rows } = await pool.query('SELECT username FROM admin_auth WHERE id = 1');
      out.settings = { ...out.settings, adminUsername: rows[0] ? rows[0].username : 'admin' };
    }
    res.json(out);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

/* ============================================================
   GENERIC DATA WRITE — mirrors the old saveKey(key) call.
   Admin can write batches/attendance/homework/students/settings.
   Both admin and student can write fees/homeworkStatus (needed so
   students can submit fee payments and mark homework done).
   ============================================================ */
app.put('/api/data/:key', auth(), async (req, res) => {
  const { key } = req.params;
  const { value } = req.body || {};
  if (value === undefined) return res.status(400).json({ error: 'Missing value' });

  const isAdmin = req.user.role === 'admin';
  if (ADMIN_ONLY_KEYS.includes(key) && !isAdmin) {
    return res.status(403).json({ error: 'Only admin can modify ' + key });
  }
  if (!ADMIN_ONLY_KEYS.includes(key) && !SHARED_WRITE_KEYS.includes(key)) {
    return res.status(400).json({ error: 'Unknown key' });
  }
  if (key === 'settings' && isAdmin) {
    // Only instituteName flows through the generic endpoint; admin
    // credentials are changed via /api/admin/credentials so the
    // password is always hashed server-side, never round-tripped as text.
    const current = (await getKV('settings')) || {};
    await setKV('settings', { instituteName: value.instituteName ?? current.instituteName });
    return res.json({ ok: true });
  }
  // students array must never carry a plaintext password field
  if (key === 'students' && Array.isArray(value)) {
    value.forEach(s => { delete s.password; });
  }
  await setKV(key, value);
  res.json({ ok: true });
});

/* ============================================================
   STUDENT MANAGEMENT (admin only) — creates auth rows + returns
   a one-time plaintext temp password for the admin to hand out.
   ============================================================ */
app.post('/api/students', auth('admin'), async (req, res) => {
  try {
    const data = req.body || {};
    if (!data.name || !data.roll) return res.status(400).json({ error: 'Name and roll number are required' });

    const students = (await getKV('students')) || [];
    const username = uniqueUsernameSQL(students, data.roll);
    const id = uid('stu');
    const tempPassword = 'student123';
    const hash = await bcrypt.hash(tempPassword, 10);

    const newStudent = {
      id, username,
      name: data.name, roll: data.roll,
      std: data.std || '', batchId: data.batchId || null,
      guardian: data.guardian || '', phone: data.phone || '',
      monthlyFee: Number(data.monthlyFee) || 0,
      admissionDate: data.admissionDate || new Date().toISOString().slice(0, 10),
    };
    students.push(newStudent);
    await setKV('students', students);
    await pool.query(
      'INSERT INTO student_auth (student_id, username, password_hash) VALUES ($1,$2,$3)',
      [id, username, hash]
    );
    res.json({ student: newStudent, tempPassword });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/students/:id/reset-password', auth('admin'), async (req, res) => {
  try {
    const { id } = req.params;
    const tempPassword = 'student123';
    const hash = await bcrypt.hash(tempPassword, 10);
    const result = await pool.query(
      'UPDATE student_auth SET password_hash = $1 WHERE student_id = $2 RETURNING username',
      [hash, id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Student not found' });
    res.json({ tempPassword, username: result.rows[0].username });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/students/:id', auth('admin'), async (req, res) => {
  try {
    const { id } = req.params;
    const students = ((await getKV('students')) || []).filter(s => s.id !== id);
    await setKV('students', students);
    await pool.query('DELETE FROM student_auth WHERE student_id = $1', [id]);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

/* ============================================================
   PASSWORD CHANGES (hashed server-side, never stored as text)
   ============================================================ */
app.post('/api/me/change-password', auth('student'), async (req, res) => {
  try {
    const { newPassword } = req.body || {};
    if (!newPassword || newPassword.length < 4) return res.status(400).json({ error: 'Password too short' });
    const hash = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE student_auth SET password_hash = $1 WHERE student_id = $2', [hash, req.user.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/admin/credentials', auth('admin'), async (req, res) => {
  try {
    const { currentPassword, newUsername, newPassword } = req.body || {};
    const { rows } = await pool.query('SELECT * FROM admin_auth WHERE id = 1');
    const admin = rows[0];
    const ok = await bcrypt.compare(currentPassword || '', admin.password_hash);
    if (!ok) return res.status(401).json({ error: 'Current password is incorrect' });

    const username = newUsername && newUsername.trim() ? newUsername.trim() : admin.username;
    let hash = admin.password_hash;
    if (newPassword && newPassword.trim()) {
      if (newPassword.length < 4) return res.status(400).json({ error: 'Password too short' });
      hash = await bcrypt.hash(newPassword, 10);
    }
    await pool.query('UPDATE admin_auth SET username = $1, password_hash = $2 WHERE id = 1', [username, hash]);
    res.json({ ok: true, username });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/', (req, res) => res.send('Ledger ERP API is running.'));

ensureSchema()
  .then(() => {
    app.listen(PORT, () => console.log(`Ledger ERP API listening on port ${PORT}`));
  })
  .catch(err => {
    console.error('Failed to initialize database schema:', err);
    process.exit(1);
  });
