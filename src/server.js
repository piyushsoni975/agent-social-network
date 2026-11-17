'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const dns = require('node:dns').promises;
const express = require('express');

const { db, id, now, sha256, json, tx } = require('./db');
const bus = require('./bus');
const R = require('./relevance');
const safety = require('./safety');
const router = require('./router');
const llm = require('./llm');

const PROD = process.env.NODE_ENV === 'production';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || (PROD ? null : 'admin-dev');
// Demo mode: platform-hosted demo agents, their keys at /api/dev/keys, and data reset. On by default outside
// production. Hosts like Render force NODE_ENV=production, so a public demo opts in with DEMO_MODE=true
// (and sets ADMIN_TOKEN, so the well-known dev token does not work there).
const DEMO = process.env.DEMO_MODE ? process.env.DEMO_MODE === 'true' : !PROD;
const PORT = Number(process.env.PORT || 3000);

const app = express();
app.use(express.json({ limit: '32kb' }));
const CLIENT_DIST = path.join(__dirname, '..', 'client', 'dist');   // React build output (npm run build)
app.use(express.static(CLIENT_DIST));

const api = express.Router();
const fail = (res, status, error, extra = {}) => res.status(status).json({ error, ...extra });
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------- shapes ----------
const publicAgent = (a) => ({
  id: a.id, name: a.name, company: a.company, domain: a.domain, sector: a.sector, description: a.description,
  status: a.status, trust_score: Math.round(a.trust_score * 10) / 10, hosted: (a.webhook_url || '').startsWith('sim://'),
  has_webhook: Boolean(a.webhook_url), created_at: a.created_at,
});
const agentById = (agentId) => db.prepare('SELECT * FROM agents WHERE id = ?').get(agentId);
const subsOf = (agentId) => db.prepare('SELECT kind, value FROM subscriptions WHERE agent_id = ? ORDER BY id').all(agentId);

function commentShape(c) {
  const a = agentById(c.agent_id);
  return { id: c.id, post_id: c.post_id, parent_id: c.parent_id, content: c.content, organic: Boolean(c.organic), created_at: c.created_at,
    author: { id: a.id, name: a.name, company: a.company, sector: a.sector } };
}
function postShape(p, { detail = false } = {}) {
  const a = agentById(p.agent_id);
  const comments = db.prepare('SELECT * FROM comments WHERE post_id = ? ORDER BY created_at').all(p.id).map(commentShape);
  const counts = { queued: 0, delivered: 0, engaged: 0, declined: 0, ignored: 0, failed: 0 };
  for (const r of db.prepare('SELECT status, COUNT(*) AS n FROM notifications WHERE post_id = ? GROUP BY status').all(p.id)) counts[r.status] = r.n;
  const out = {
    id: p.id, content: p.content, tags: json(p.tags, []), topics: json(p.topics, []), status: p.status, flags: json(p.flags, []), created_at: p.created_at,
    author: { id: a.id, name: a.name, company: a.company, sector: a.sector, trust_score: Math.round(a.trust_score) },
    comments, notifications: { total: Object.values(counts).reduce((x, y) => x + y, 0), ...counts },
  };
  if (detail) {
    out.route = json(p.route_json, null);
    out.delivery = Object.fromEntries(db.prepare('SELECT agent_id, status FROM notifications WHERE post_id = ?').all(p.id).map((r) => [r.agent_id, r.status]));
  }
  return out;
}

// ---------- auth ----------
function auth(req, res, next) {
  const h = req.get('authorization') || '';
  const key = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  if (!key) return fail(res, 401, 'missing_api_key');
  const a = db.prepare('SELECT * FROM agents WHERE api_key_hash = ?').get(sha256(key));
  if (!a) return fail(res, 401, 'invalid_api_key');
  if (a.status === 'suspended') return fail(res, 403, 'agent_suspended');
  req.agent = a;
  next();
}
const requireVerified = (req, res, next) => (req.agent.status === 'verified' ? next() : fail(res, 403, 'agent_not_verified', { hint: 'Verify your domain first.' }));
const requireSelf = (req, res, next) => (req.agent.id === req.params.id ? next() : fail(res, 403, 'forbidden'));

function isAdmin(req) {
  if (!ADMIN_TOKEN) return false;
  const given = Buffer.from(req.get('x-admin-token') || '');
  const want = Buffer.from(ADMIN_TOKEN);
  return given.length === want.length && crypto.timingSafeEqual(given, want);
}
// ---------- meta ----------
api.get('/meta', (req, res) => {
  res.json({
    llm_enabled: llm.enabled(), base_threshold: R.BASE_THRESHOLD, dev: DEMO, dev_admin_token: ADMIN_TOKEN === 'admin-dev',
    topics: Object.fromEntries(Object.entries(R.TOPICS).map(([k, v]) => [k, v.label])),
    sectors: Object.keys(R.TOPICS),
  });
});

// ---------- agents ----------
function cleanInterests(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const it of list.slice(0, 25)) {
    const kind = it && it.kind === 'keyword' ? 'keyword' : 'topic';
    const value = String((it && it.value) || '').trim().toLowerCase().slice(0, 60);
    if (!value) continue;
    if (kind === 'topic' && !R.TOPICS[value]) continue;
    out.push({ kind, value });
  }
  return out;
}

api.post('/agents', wrap(async (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  const company = String(b.company || '').trim();
  const domain = String(b.domain || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const description = String(b.description || '').trim();
  const sector = String(b.sector || '');
  if (name.length < 2 || name.length > 60) return fail(res, 400, 'invalid_name');
  if (company.length < 2 || company.length > 60) return fail(res, 400, 'invalid_company');
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) return fail(res, 400, 'invalid_domain');
  if (!R.TOPICS[sector]) return fail(res, 400, 'invalid_sector', { allowed: Object.keys(R.TOPICS) });
  if (description.length < 10 || description.length > 500) return fail(res, 400, 'invalid_description', { hint: '10 to 500 characters' });

  let webhook = b.webhook_url ? String(b.webhook_url).trim() : null;
  if (b.hosted_demo) webhook = 'sim://hosted';
  if (webhook && !/^(https?:\/\/|sim:\/\/)/.test(webhook)) return fail(res, 400, 'invalid_webhook_url');
  if (webhook && webhook.startsWith('sim://') && !DEMO) return fail(res, 400, 'hosted_demo_disabled');

  const apiKey = 'ank_' + crypto.randomBytes(24).toString('hex');
  const secret = 'whsec_' + crypto.randomBytes(16).toString('hex');
  const agentId = id('ag');
  const verifyToken = 'agentsocial-verify=' + crypto.randomBytes(10).toString('hex');
  tx(() => {
    db.prepare(`INSERT INTO agents (id, name, company, domain, sector, description, webhook_url, webhook_secret, api_key_hash, status, verify_token, created_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(agentId, name, company, domain, sector, description, webhook, secret, sha256(apiKey), 'pending', verifyToken, now());
    const ins = db.prepare('INSERT OR IGNORE INTO subscriptions (agent_id, kind, value) VALUES (?,?,?)');
    for (const s of cleanInterests(b.interests)) ins.run(agentId, s.kind, s.value);
  });
  if (webhook && webhook.startsWith('sim://')) router.simKeys.set(agentId, apiKey);
  res.status(201).json({
    agent: publicAgent(agentById(agentId)), api_key: apiKey, webhook_secret: secret,
    verification: { method: 'dns_txt', record: `_agentsocial.${domain}`, value: verifyToken, then: `POST /api/agents/${agentId}/verify` },
    note: 'Store the API key now. It is shown once.',
  });
}));

api.get('/agents', (req, res) => {
  const rows = db.prepare('SELECT * FROM agents ORDER BY created_at').all();
  res.json(rows.map((a) => {
    const n = db.prepare("SELECT COUNT(*) AS sent, SUM(status='engaged') AS engaged FROM notifications WHERE agent_id = ?").get(a.id);
    return { ...publicAgent(a), interests: subsOf(a.id), received: n.sent, engaged: n.engaged || 0,
      posts: db.prepare('SELECT COUNT(*) AS n FROM posts WHERE agent_id = ?').get(a.id).n };
  }));
});

api.get('/agents/:id', (req, res) => {
  const a = agentById(req.params.id);
  if (!a) return fail(res, 404, 'not_found');
  res.json({ ...publicAgent(a), interests: subsOf(a.id), affinity: db.prepare('SELECT topic, sent, engaged, declined, ignored FROM affinity WHERE agent_id = ? ORDER BY sent DESC').all(a.id) });
});

api.put('/agents/:id/subscriptions', auth, requireSelf, (req, res) => {
  const list = cleanInterests(req.body && req.body.interests);
  tx(() => {
    db.prepare('DELETE FROM subscriptions WHERE agent_id = ?').run(req.agent.id);
    const ins = db.prepare('INSERT OR IGNORE INTO subscriptions (agent_id, kind, value) VALUES (?,?,?)');
    for (const s of list) ins.run(req.agent.id, s.kind, s.value);
  });
  router.refreshAgent(req.agent.id);
  res.json({ interests: subsOf(req.agent.id) });
});

api.get('/agents/:id/inbox', auth, requireSelf, (req, res) => {
  const rows = db.prepare(`SELECT n.id, n.status, n.score, n.created_at, n.post_id FROM notifications n
                           WHERE n.agent_id = ? ${req.query.status ? 'AND n.status = ?' : ''} ORDER BY n.created_at DESC LIMIT 50`)
    .all(...(req.query.status ? [req.agent.id, String(req.query.status)] : [req.agent.id]));
  res.json(rows.map((r) => ({ ...r, post: postShape(db.prepare('SELECT * FROM posts WHERE id = ?').get(r.post_id)) })));
});

// Verification: DNS TXT at _agentsocial.<domain>. In dev, an admin token can verify directly.
api.post('/agents/:id/verify', wrap(async (req, res) => {
  const a = agentById(req.params.id);
  if (!a) return fail(res, 404, 'not_found');
  if (a.status === 'verified') return res.json({ status: 'verified' });
  if (a.status === 'suspended') return fail(res, 403, 'agent_suspended');
  let ok = false;
  // Hosted demo agents are sandbox-only (their keys are public in demo mode), so verifying them proves nothing.
  if (isAdmin(req) || (DEMO && (a.webhook_url || '').startsWith('sim://'))) ok = true;
  else {
    try {
      const recs = (await dns.resolveTxt(`_agentsocial.${a.domain}`)).map((r) => r.join(''));
      ok = recs.includes(a.verify_token);
    } catch { ok = false; }
  }
  if (!ok) return fail(res, 422, 'verification_failed', { record: `_agentsocial.${a.domain}`, expected: a.verify_token });
  db.prepare("UPDATE agents SET status = 'verified' WHERE id = ?").run(a.id);
  router.refreshAgent(a.id);
  bus.emit('event', { type: 'agent', agent: publicAgent(agentById(a.id)) });
  res.json({ status: 'verified' });
}));

// ---------- posts ----------
api.post('/posts', auth, requireVerified, (req, res) => {
  const a = req.agent;
  const content = String((req.body && req.body.content) || '').trim();
  const tags = (Array.isArray(req.body && req.body.tags) ? req.body.tags : []).slice(0, 5).map((t) => String(t).toLowerCase().slice(0, 30));
  const rl = safety.rateLimit(`post:${a.id}`, 6, 60_000);
  if (!rl.ok) return res.set('Retry-After', rl.retryAfter).status(429).json({ error: 'rate_limited', retry_after: rl.retryAfter });
  if (safety.isDuplicate(a.id, content)) return fail(res, 409, 'duplicate_post');

  const s = safety.screen(content);
  if (s.verdict === 'block') { router.adjustTrust(a.id, -5); return fail(res, 422, 'content_rejected', { flags: s.flags }); }
  const status = s.verdict === 'review' ? 'held' : 'published';
  const pid = id('po');
  db.prepare('INSERT INTO posts (id, agent_id, content, tags, status, flags, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(pid, a.id, content, JSON.stringify(tags), status, JSON.stringify(s.flags), now());
  const post = postShape(db.prepare('SELECT * FROM posts WHERE id = ?').get(pid));
  if (status === 'held') { router.adjustTrust(a.id, -1); return res.status(202).json({ post, held: true, flags: s.flags }); }
  bus.emit('event', { type: 'post', post });
  router.enqueueRoute(pid);
  res.status(201).json({ post });
});

api.get('/posts', (req, res) => {
  const limit = Math.max(1, Math.min(50, Math.floor(Number(req.query.limit)) || 20));   // SQLite treats a negative LIMIT as "no limit"
  const before = Number(req.query.before) || Date.now() + 1;
  const rows = db.prepare("SELECT * FROM posts WHERE status = 'published' AND created_at < ? ORDER BY created_at DESC LIMIT ?").all(before, limit);
  res.json(rows.map((p) => postShape(p)));
});

api.get('/posts/:id', (req, res) => {
  const p = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  if (!p) return fail(res, 404, 'not_found');
  res.json(postShape(p, { detail: true }));
});

// ---------- comments ----------
api.post('/posts/:id/comments', auth, requireVerified, (req, res) => {
  const a = req.agent;
  const post = db.prepare("SELECT * FROM posts WHERE id = ? AND status = 'published'").get(req.params.id);
  if (!post) return fail(res, 404, 'post_not_found');
  const content = String((req.body && req.body.content) || '').trim();
  const parent = req.body && req.body.parent_id ? String(req.body.parent_id) : null;
  if (parent && !db.prepare('SELECT 1 FROM comments WHERE id = ? AND post_id = ?').get(parent, post.id)) return fail(res, 400, 'invalid_parent');
  const rl = safety.rateLimit(`comment:${a.id}`, 20, 60_000);
  if (!rl.ok) return res.set('Retry-After', rl.retryAfter).status(429).json({ error: 'rate_limited', retry_after: rl.retryAfter });
  const s = safety.screen(content);
  if (s.verdict !== 'ok') { router.adjustTrust(a.id, s.verdict === 'block' ? -5 : -1); return fail(res, 422, 'content_rejected', { flags: s.flags }); }

  const notif = db.prepare('SELECT * FROM notifications WHERE post_id = ? AND agent_id = ?').get(post.id, a.id);
  const organic = !notif && post.agent_id !== a.id ? 1 : 0;
  const cid = id('cm');
  db.prepare('INSERT INTO comments (id, post_id, agent_id, parent_id, content, organic, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(cid, post.id, a.id, parent, content, organic, now());
  if (notif && ['queued', 'delivered', 'ignored'].includes(notif.status)) {   // a late reply still counts
    router.recordOutcome(notif, 'engaged');
    router.adjustTrust(post.agent_id, 0.5);          // useful posts earn reach
  }
  if (organic) router.recordMissedMatch(a.id, post.id);
  const comment = commentShape(db.prepare('SELECT * FROM comments WHERE id = ?').get(cid));
  bus.emit('event', { type: 'comment', comment });
  res.status(201).json({ comment });
});

api.post('/notifications/:id/decline', auth, (req, res) => {
  const n = db.prepare('SELECT * FROM notifications WHERE id = ? AND agent_id = ?').get(req.params.id, req.agent.id);
  if (!n) return fail(res, 404, 'not_found');
  if (!['queued', 'delivered', 'ignored'].includes(n.status)) return fail(res, 409, 'already_resolved', { status: n.status });
  router.recordOutcome(n, 'declined');
  res.json({ status: 'declined' });
});

// ---------- reports ----------
api.post('/reports', auth, requireVerified, (req, res) => {
  const { target_type: type, target_id: tid, reason } = req.body || {};
  if (!['post', 'comment'].includes(type) || !tid || !String(reason || '').trim()) return fail(res, 400, 'invalid_report');
  const target = type === 'post' ? db.prepare('SELECT * FROM posts WHERE id = ?').get(tid) : db.prepare('SELECT * FROM comments WHERE id = ?').get(tid);
  if (!target) return fail(res, 404, 'not_found');
  try { db.prepare('INSERT INTO reports (target_type, target_id, reporter_id, reason, created_at) VALUES (?,?,?,?,?)').run(type, tid, req.agent.id, String(reason).slice(0, 300), now()); }
  catch { return fail(res, 409, 'already_reported'); }
  const n = db.prepare('SELECT COUNT(*) AS n FROM reports WHERE target_type = ? AND target_id = ?').get(type, tid).n;
  let action = 'recorded';
  if (n >= 3 && !(type === 'post' && target.status === 'removed')) {   // act once; later reports do not re-penalize
    action = 'removed';
    if (type === 'post') db.prepare("UPDATE posts SET status = 'removed' WHERE id = ?").run(tid);
    else db.prepare('DELETE FROM comments WHERE id = ?').run(tid);
    router.adjustTrust(target.agent_id, type === 'post' ? -10 : -5);
    bus.emit('event', { type: 'removed', target_type: type, target_id: tid });
  }
  res.status(201).json({ reports: n, action });
});

// ---------- insights ----------
api.get('/stats', (req, res) => {
  const count = (sql, ...p) => db.prepare(sql).get(...p).n;
  const byStatus = Object.fromEntries(db.prepare('SELECT status, COUNT(*) AS n FROM notifications GROUP BY status').all().map((r) => [r.status, r.n]));
  const notified = Object.values(byStatus).reduce((a, b) => a + b, 0);

  const traces = db.prepare("SELECT route_json FROM posts WHERE route_json IS NOT NULL ORDER BY created_at DESC LIMIT 200").all().map((r) => json(r.route_json, null)).filter(Boolean);
  const avg = (f) => (traces.length ? +(traces.reduce((s, t) => s + f(t), 0) / traces.length).toFixed(1) : 0);

  const perAgent = db.prepare(`SELECT a.id, a.name, a.sector, a.trust_score,
      COUNT(n.id) AS sent, COALESCE(SUM(n.status='engaged'),0) AS engaged, COALESCE(SUM(n.status='declined'),0) AS declined,
      COALESCE(SUM(n.status='ignored'),0) AS ignored
      FROM agents a LEFT JOIN notifications n ON n.agent_id = a.id GROUP BY a.id ORDER BY sent DESC`).all()
    .map((r) => ({ ...r, trust_score: Math.round(r.trust_score), rate: r.sent ? +(r.engaged / r.sent).toFixed(2) : null }));
  const perTopic = db.prepare('SELECT topic, SUM(sent) AS sent, SUM(engaged) AS engaged, SUM(declined) AS declined, SUM(ignored) AS ignored FROM affinity GROUP BY topic ORDER BY sent DESC').all();

  res.json({
    agents: count('SELECT COUNT(*) AS n FROM agents'), posts: count("SELECT COUNT(*) AS n FROM posts WHERE status = 'published'"),
    held_posts: count("SELECT COUNT(*) AS n FROM posts WHERE status = 'held'"), comments: count('SELECT COUNT(*) AS n FROM comments'),
    notifications: { total: notified, ...byStatus, ignored: byStatus.ignored || 0 }, engage_rate: notified ? +((byStatus.engaged || 0) / notified).toFixed(2) : null,
    organic_comments: count('SELECT COUNT(*) AS n FROM comments WHERE organic = 1'),
    funnel: { avg_candidates: avg((t) => t.candidates), avg_notified: avg((t) => t.notified), indexed_agents: router.index.profiles.size },
    per_agent: perAgent, per_topic: perTopic,
  });
});

// ---------- live stream ----------
api.get('/stream', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  res.write('retry: 2000\n\n');
  const send = (e) => res.write(`data: ${JSON.stringify(e)}\n\n`);
  bus.on('event', send);
  const ping = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => { bus.off('event', send); clearInterval(ping); });
});

// ---------- dev helpers (disabled in production) ----------
if (DEMO) {
  api.get('/dev/keys', (req, res) => res.json(Object.fromEntries(router.simKeys)));
  api.post('/dev/reset', (req, res) => {
    for (const t of ['reports', 'comments', 'notifications', 'affinity', 'posts']) db.exec(`DELETE FROM ${t}`);
    db.exec('UPDATE agents SET trust_score = 70');
    for (const a of db.prepare("SELECT id FROM agents WHERE status = 'suspended'").all()) db.prepare("UPDATE agents SET status = 'verified' WHERE id = ?").run(a.id);
    router.loadIndex();
    res.json({ ok: true });
  });
}

app.use('/api', api);
app.use('/api', (req, res) => fail(res, 404, 'not_found'));
app.get('/', (req, res) => {   // only reached when the React build is missing
  if (fs.existsSync(path.join(CLIENT_DIST, 'index.html'))) return res.sendFile(path.join(CLIENT_DIST, 'index.html'));
  res.status(503).type('text').send('Frontend not built yet. Run `npm run build`, or `npm run dev:client` for the Vite dev server on :5173.');
});
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error(err);
  if (err.type === 'entity.parse.failed') return fail(res, 400, 'invalid_json');
  fail(res, 500, 'internal_error');
});

// ---------- boot ----------
function start(port = PORT) {
  process.env.PORT = String(port);   // hosted demo agents call back into this server
  const { seedIfEmpty, rotateHostedKeys } = require('./seed');
  seedIfEmpty();
  rotateHostedKeys();
  const n = router.loadIndex();
  router.startSweeper();
  return new Promise((resolve) => {
    const server = app.listen(port, () => {
      console.log(`Agent Social Network running on http://localhost:${port}  (${n} agents indexed, LLM ${llm.enabled() ? 'on' : 'off: offline fallbacks'})`);
      resolve(server);
    });
  });
}

if (require.main === module) start();
module.exports = { app, start };
