import express from 'express';
import crypto from 'crypto';
import pkg from 'pg';
import cookieParser from 'cookie-parser';

const { Pool } = pkg;

const app = express();

// ✅ FIX 1: SSL for Render
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

app.use(express.json());
app.use(cookieParser());

// ✅ FIX 2: port ديناميكي (Render يحتاج هذا)
const PORT = process.env.PORT || 3000;

// ===== DB INIT (safe startup) =====
const initDB = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT,
        status TEXT DEFAULT 'trial',
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('✅ Database ready');
  } catch (err) {
    console.error('❌ DB init error:', err);
    process.exit(1); // يوقف السيرفر لو DB فشلت
  }
};

// ===== Helpers =====
const sign = (id) => {
  return id + '.' + crypto.createHmac('sha256', process.env.SECRET).update(id).digest('hex');
};

const unsign = (token) => {
  if (!token) return null;
  const [id, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', process.env.SECRET).update(id).digest('hex');
  return sig === expected ? id : null;
};

// ===== Routes =====

// init session
app.get('/api/init', async (req, res) => {
  try {
    let userId = unsign(req.cookies.sid);

    if (!userId) {
      userId = crypto.randomBytes(16).toString('hex');

      res.cookie('sid', sign(userId), {
        httpOnly: true,
        sameSite: 'lax',
        secure: true
      });

      await pool.query('INSERT INTO users (id) VALUES ($1)', [userId]);
    }

    const { rows } = await pool.query(
      'SELECT email, status FROM users WHERE id=$1',
      [userId]
    );

    res.json(rows[0] || {});
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'server error' });
  }
});

// save email
app.post('/api/email', async (req, res) => {
  try {
    const userId = unsign(req.cookies.sid);
    if (!userId) return res.status(401).json({ error: 'no session' });

    const { email } = req.body;

    await pool.query(
      'UPDATE users SET email=$1 WHERE id=$2',
      [email, userId]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'server error' });
  }
});

// checkout
app.post('/api/checkout', async (req, res) => {
  res.json({ url: 'https://zenx.academy/zenx-hub/' });
});

// get user
app.get('/api/me', async (req, res) => {
  try {
    const userId = unsign(req.cookies.sid);
    if (!userId) return res.status(401).json({ error: 'no session' });

    const { rows } = await pool.query(
      'SELECT email, status FROM users WHERE id=$1',
      [userId]
    );

    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'server error' });
  }
});

// ===== START SERVER =====
const startServer = async () => {
  await initDB();

  app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
  });
};

startServer();
