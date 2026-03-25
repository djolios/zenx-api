// ============ STRIPPED v6 (Validation Mode) ============
// Goal: Answer "Will 1000 visitors convert?" in 7 days.
// No WebSocket. No queues. Just fast feedback loops.
// server.js - 150 lines, deploy in 5 minutes
import express from 'express';
import crypto from 'crypto';
import { Paddle } from '@paddle/paddle-node-sdk';
import pg from 'pg';
import cookieParser from 'cookie-parser';
const { Pool } = pg;
const app = express();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
await pool.query(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE,
    paddle_subscription_id TEXT,
    status TEXT DEFAULT 'trial',
    created_at TIMESTAMP DEFAULT NOW(),
    paid_at TIMESTAMP,
    cohort TEXT DEFAULT 'test-1'
  );
 
  CREATE TABLE IF NOT EXISTS events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id TEXT,
    event_type TEXT,
    metadata JSONB,
    created_at TIMESTAMP DEFAULT NOW()
  );
 
  CREATE INDEX idx_events_user ON events(user_id, created_at);
`);
const paddle = new Paddle(process.env.PADDLE_API_KEY, {
  environment: process.env.PADDLE_ENV
});
const PRODUCTS = {
  initiate: {
    monthly: 'pri_01kmdbamyxgzp2azt2ekgbn8r9',
    yearly: 'pri_01kmdbdwc5xwyq3r1ehmc2q3pg'
  },
  architect: {
    monthly: 'pri_01kmdbh7kqjpk7megtyewewzt6',
    yearly: 'pri_01kmdbksrb60r640mvhg0qrkk9'
  }
};
app.use(cookieParser());
app.use(express.static('public'));
app.use('/webhook', express.raw({type: 'application/json'}));
app.use(express.json());
// Simple session (no rotation, no complexity)
const sign = (id) => `${id}.${crypto.createHmac('sha256', process.env.SECRET).update(id).digest('hex')}`;
const unsign = (token) => {
  if (!token) return null;
  const [id, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', process.env.SECRET).update(id).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)) ? id : null;
  } catch { return null; }
};
// Track everything
const track = (userId, event, meta = {}) => {
  pool.query('INSERT INTO events (user_id, event_type, metadata) VALUES ($1, $2, $3)',
    [userId, event, JSON.stringify(meta)]).catch(console.error);
};
// 1. Land → give session
app.get('/api/init', async (req, res) => {
  let userId = unsign(req.cookies.sid);
 
  if (!userId) {
    userId = crypto.randomBytes(16).toString('hex');
    res.cookie('sid', sign(userId), { httpOnly: true, secure: true, sameSite: 'strict' });
    await pool.query('INSERT INTO users (id) VALUES ($1)', [userId]);
    track(userId, 'session_created', { source: req.headers.referer });
  }
 
  const { rows } = await pool.query('SELECT status, email FROM users WHERE id = $1', [userId]);
  res.json({ userId, status: rows[0]?.status, hasEmail: !!rows[0]?.email });
});
// 2. Email capture (funnel step 1)
app.post('/api/email', async (req, res) => {
  const userId = unsign(req.cookies.sid);
  if (!userId) return res.status(401).json({error: 'no session'});
 
  const { email } = req.body;
  if (!email?.includes('@')) return res.status(400).json({error: 'invalid'});
 
  await pool.query('UPDATE users SET email = $1 WHERE id = $2', [email.toLowerCase(), userId]);
  track(userId, 'email_captured', { email });
 
  res.json({ok: true});
});
// 3. Checkout (funnel step 2)
app.post('/api/checkout', async (req, res) => {
  const userId = unsign(req.cookies.sid);
  const { plan } = req.body;
 
  track(userId, 'checkout_started', { plan });
 
  const { rows } = await pool.query('SELECT email FROM users WHERE id = $1', [userId]);
  const email = rows[0]?.email;
 
  const customer = await paddle.customers.create({ email });
 
  const [productKey, billingKey] = plan.split('-');
  const priceId = PRODUCTS[productKey]?.[billingKey];
 
  const checkout = await paddle.checkouts.create({
    customerId: customer.id,
    items: [{ priceId, quantity: 1 }],
    customData: { userId },
    successUrl: 'https://zenx.academy/zenx-hub/',
    cancelUrl: 'https://zenx.academy/cancel'
  });
 
  res.json({ url: checkout.url });
});
// 4. Webhook (simple, synchronous)
app.post('/webhook/paddle', async (req, res) => {
  const signature = req.headers['paddle-signature'];
  const secret = process.env.PADDLE_WEBHOOK_SECRET;
  try {
    const event = paddle.webhooks.unmarshal(req.body, secret, signature);
    res.json({ok: true});
 
    if (event.eventType === 'subscription.created') {
      const userId = event.data.customData?.userId;
      if (!userId) return;
     
      await pool.query(`
        UPDATE users SET
          paddle_subscription_id = $1,
          status = 'active',
          paid_at = NOW()
        WHERE id = $2
      `, [event.data.id, userId]);
     
      track(userId, 'paid', {
        amount: event.data.items?.[0]?.price?.unitPrice?.amount,
        plan: event.data.items?.[0]?.price?.product?.name
      });
    }
  } catch (err) {
    return res.status(400).json({ error: 'invalid signature' });
  }
});
// 5. Dashboard metrics (the truth)
app.get('/admin/metrics', async (req, res) => {
  // Funnel conversion
  const { rows: funnel } = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE event_type = 'session_created') as visitors,
      COUNT(*) FILTER (WHERE event_type = 'email_captured') as emails,
      COUNT(*) FILTER (WHERE event_type = 'checkout_started') as checkouts,
      COUNT(*) FILTER (WHERE event_type = 'paid') as paid
    FROM events
    WHERE created_at > NOW() - INTERVAL '7 days'
  `);
 
  // By cohort
  const { rows: cohorts } = await pool.query(`
    SELECT cohort,
      COUNT(*) as users,
      COUNT(*) FILTER (WHERE status = 'active') as paid,
      ROUND(100.0 * COUNT(*) FILTER (WHERE status = 'active') / NULLIF(COUNT(*), 0), 1) as conversion_pct
    FROM users
    WHERE created_at > NOW() - INTERVAL '7 days'
    GROUP BY cohort
  `);
 
  res.json({
    funnel: {
      visitors: parseInt(funnel[0].visitors),
      emails: parseInt(funnel[0].emails),
      checkouts: parseInt(funnel[0].checkouts),
      paid: parseInt(funnel[0].paid),
      email_rate: Math.round((funnel[0].emails / funnel[0].visitors) * 100) || 0,
      checkout_rate: Math.round((funnel[0].checkouts / funnel[0].emails) * 100) || 0,
      conversion_rate: Math.round((funnel[0].paid / funnel[0].visitors) * 100) || 0
    },
    cohorts
  });
});
// 6. Simple retention (email nudge at 24h)
setInterval(async () => {
  const { rows } = await pool.query(`
    SELECT id, email, created_at
    FROM users
    WHERE status = 'trial'
      AND created_at < NOW() - INTERVAL '24 hours'
      AND created_at > NOW() - INTERVAL '25 hours'
      AND NOT EXISTS (
        SELECT 1 FROM events
        WHERE user_id = users.id AND event_type = 'paid'
      )
  `);
 
  for (const user of rows) {
    // Send via your email provider (Resend/SendGrid)
    console.log(`[RETENTION] Email to ${user.email}: "You started but didn't finish..."`);
    track(user.id, 'retention_email_sent');
  }
}, 60000); // Check every minute
app.get('/api/me', async (req, res) => {
  const userId = unsign(req.cookies.sid);
  if (!userId) return res.status(401).json({ error: 'no session' });
  const { rows } = await pool.query('SELECT status, email FROM users WHERE id = $1', [userId]);
  res.json({ userId, status: rows[0]?.status || 'trial', email: rows[0]?.email, accessLayer: rows[0]?.status === 'active' ? 'initiate' : 'observer' });
});
app.listen(3000, () => console.log('[SERVER] Validation mode on :3000'));
