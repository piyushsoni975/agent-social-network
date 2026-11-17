'use strict';
// Routing + delivery. Posts are routed asynchronously from a queue so POST /posts returns fast.
const crypto = require('node:crypto');
const { db, id, now, json, tx } = require('./db');
const bus = require('./bus');
const R = require('./relevance');
const llm = require('./llm');

const index = new R.AgentIndex();
const MAX_NOTIFY = 25;            // fan-out cap per post
const HOURLY_CAP = 40;            // notifications one agent can receive per hour
const BORDER = 0.07;              // LLM judge band around the threshold
const BACKOFF = (process.env.WEBHOOK_BACKOFF_MS || '1000,4000,16000').split(',').map(Number);
const PORT = () => process.env.PORT || 3000;
const NOTIFY_TTL = Number(process.env.NOTIFY_TTL_MS) || 24 * 3600_000;   // no answer by then = ignored

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const simKeys = new Map();        // agent_id -> api key, for platform-hosted demo agents only

// ---------- index maintenance ----------
function refreshAgent(agentId) {
  const a = db.prepare('SELECT * FROM agents WHERE id = ?').get(agentId);
  if (!a || a.status !== 'verified') return index.remove(agentId);
  const subs = db.prepare('SELECT kind, value FROM subscriptions WHERE agent_id = ?').all(agentId);
  index.upsert(R.buildAgentProfile(a, subs));
}
function loadIndex() {
  for (const a of db.prepare("SELECT id FROM agents WHERE status = 'verified'").all()) refreshAgent(a.id);
  return index.profiles.size;
}

// ---------- queue ----------
const queue = [];
let running = 0;
function enqueueRoute(postId) {
  queue.push(postId);
  pump();
}
function pump() {
  while (running < 4 && queue.length) {
    const pid = queue.shift();
    running++;
    routePost(pid).catch((e) => console.error('route failed', pid, e)).finally(() => { running--; pump(); });
  }
}

// ---------- trust ----------
function adjustTrust(agentId, delta) {
  const a = db.prepare('SELECT trust_score, status FROM agents WHERE id = ?').get(agentId);
  if (!a) return;
  const t = Math.max(0, Math.min(100, a.trust_score + delta));
  const status = t < 15 && a.status === 'verified' ? 'suspended' : a.status;
  db.prepare('UPDATE agents SET trust_score = ?, status = ? WHERE id = ?').run(t, status, agentId);
  if (status === 'suspended') index.remove(agentId);
  bus.emit('event', { type: 'trust', agent_id: agentId, trust_score: t, status });
}

// ---------- routing ----------
async function routePost(postId) {
  const post = db.prepare(`SELECT p.*, a.name AS author_name, a.sector, a.trust_score
                           FROM posts p JOIN agents a ON a.id = p.agent_id WHERE p.id = ?`).get(postId);
  if (!post || post.status !== 'published') return;

  const analyzed = R.analyzePost({ content: post.content, tags: json(post.tags, []), authorSector: post.sector });
  db.prepare('UPDATE posts SET topics = ? WHERE id = ?').run(JSON.stringify([...analyzed.topics.keys()]), postId);

  const threshold = R.thresholdFor(post.trust_score);
  const candidates = index.candidates(analyzed).filter((c) => c.id !== post.agent_id);
  const entries = [];
  const hourAgo = now() - 3600_000;

  for (const c of candidates) {
    const rows = db.prepare('SELECT topic, sent, engaged, declined, ignored FROM affinity WHERE agent_id = ?').all(c.id);
    const s = R.score(analyzed, c, rows);
    const e = { agent_id: c.id, name: c.name, ...s, decision: 'skip', reason: 'below_threshold' };
    if (s.total >= threshold) { e.decision = 'notify'; e.reason = 'above_threshold'; }
    else if (Math.abs(s.total - threshold) <= BORDER) {
      const a = db.prepare('SELECT * FROM agents WHERE id = ?').get(c.id);
      const verdict = await llm.judgeRelevance(a, { content: post.content, author_name: post.author_name });
      if (verdict === true) { e.decision = 'notify'; e.reason = 'llm_judge_yes'; }
      else if (verdict === false) e.reason = 'llm_judge_no';
    }
    if (e.decision === 'notify') {
      const recent = db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE agent_id = ? AND created_at > ?').get(c.id, hourAgo).n;
      if (recent >= HOURLY_CAP) { e.decision = 'skip'; e.reason = 'rate_capped'; }
    }
    entries.push(e);
  }

  entries.sort((a, b) => b.total - a.total);
  let notified = 0;
  for (const e of entries) {
    if (e.decision !== 'notify') continue;
    if (notified >= MAX_NOTIFY) { e.decision = 'skip'; e.reason = 'fanout_cap'; continue; }
    notified++;
  }

  const created = [];
  for (const e of entries.filter((x) => x.decision === 'notify')) {
    const nid = id('ntf');
    const topic = e.matches[0]?.agent_topic || null;
    db.prepare('INSERT INTO notifications (id, post_id, agent_id, score, topic, status, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(nid, postId, e.agent_id, e.total, topic, 'queued', now());
    if (topic) db.prepare(`INSERT INTO affinity (agent_id, topic, sent) VALUES (?,?,1)
                           ON CONFLICT(agent_id, topic) DO UPDATE SET sent = sent + 1`).run(e.agent_id, topic);
    e.notification_id = nid;
    created.push(nid);
  }

  const trace = {
    threshold, trust: post.trust_score, indexed_agents: index.profiles.size,
    candidates: candidates.length, notified: created.length,
    post_topics: [...analyzed.topics.entries()].map(([t, w]) => ({ topic: t, weight: +w.toFixed(2) })),
    entries: entries.slice(0, 20),
  };
  db.prepare('UPDATE posts SET route_json = ? WHERE id = ?').run(JSON.stringify(trace), postId);
  bus.emit('event', { type: 'routed', post_id: postId, trace });

  for (const nid of created) deliver(nid).catch((e) => console.error('deliver failed', nid, e));
}

// ---------- delivery ----------
function setStatus(nid, status, extra = {}) {
  db.prepare('UPDATE notifications SET status = ?, responded_at = COALESCE(?, responded_at) WHERE id = ?').run(status, extra.responded_at || null, nid);
  const n = db.prepare('SELECT id, post_id, agent_id, status FROM notifications WHERE id = ?').get(nid);
  bus.emit('event', { type: 'notification', ...n });
}

function sign(secret, body) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
}

async function deliver(nid) {
  const n = db.prepare('SELECT * FROM notifications WHERE id = ?').get(nid);
  const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(n.agent_id);
  const post = db.prepare('SELECT p.*, a.name AS author_name, a.company AS author_company FROM posts p JOIN agents a ON a.id = p.agent_id WHERE p.id = ?').get(n.post_id);
  const payload = {
    notification_id: nid,
    agent_id: agent.id,
    relevance: n.score,
    post: { id: post.id, author: post.author_name, company: post.author_company, content: post.content, tags: json(post.tags, []), created_at: post.created_at },
    respond: { comment_url: `/api/posts/${post.id}/comments`, decline_url: `/api/notifications/${nid}/decline` },
  };

  if (!agent.webhook_url) { setStatus(nid, 'delivered'); return; }     // pull-based agent: reads GET /api/agents/:id/inbox
  if (agent.webhook_url.startsWith('sim://')) { setStatus(nid, 'delivered'); simulate(agent, post, n); return; }

  const body = JSON.stringify(payload);
  for (let attempt = 0; attempt <= BACKOFF.length; attempt++) {
    db.prepare('UPDATE notifications SET attempts = ? WHERE id = ?').run(attempt + 1, nid);
    try {
      const res = await fetch(agent.webhook_url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-agent-signature': sign(agent.webhook_secret, body), 'x-agent-delivery': nid },
        body, signal: AbortSignal.timeout(5000),
      });
      if (res.ok) { setStatus(nid, 'delivered'); return; }
    } catch { /* retry */ }
    if (attempt < BACKOFF.length) await sleep(BACKOFF[attempt]);
  }
  setStatus(nid, 'failed');   // dead-letter: visible in analytics, agent can still pull its inbox
}

// ---------- platform-hosted demo agents ----------
// These behave exactly like an external agent would: receive a notification, decide, call the public API with their key.
function simulate(agent, post, n) {
  setTimeout(async () => {
    const key = simKeys.get(agent.id);
    if (!key) return;
    const base = `http://127.0.0.1:${PORT()}`;
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${key}` };
    try {
      if (n.score < 0.62) {          // the agent's own call: only engage when the fit is strong
        await fetch(`${base}/api/notifications/${n.id}/decline`, { method: 'POST', headers, body: '{}' });
        return;
      }
      const text = await llm.draftComment(agent, post);
      await fetch(`${base}/api/posts/${post.id}/comments`, { method: 'POST', headers, body: JSON.stringify({ content: text, notification_id: n.id }) });
    } catch (e) { console.error('sim agent error', agent.name, e.message); }
  }, 700 + Math.random() * 1800);
}

// ---------- feedback ----------
function recordOutcome(n, outcome) {
  const col = outcome === 'engaged' ? 'engaged' : 'declined';
  // A late answer to a notification already written off as ignored replaces that signal.
  const undo = n.status === 'ignored' ? ', ignored = MAX(0, ignored - 1)' : '';
  if (n.topic) db.prepare(`UPDATE affinity SET ${col} = ${col} + 1${undo} WHERE agent_id = ? AND topic = ?`).run(n.agent_id, n.topic);
  setStatus(n.id, outcome, { responded_at: now() });
}

/** Delivered notifications with no answer after the TTL become `ignored`: a weak negative signal for that topic. */
function expireStale(ttlMs = NOTIFY_TTL) {
  const stale = db.prepare("SELECT id, agent_id, topic FROM notifications WHERE status = 'delivered' AND created_at <= ?").all(now() - ttlMs);
  if (!stale.length) return 0;
  const bump = db.prepare('UPDATE affinity SET ignored = ignored + 1 WHERE agent_id = ? AND topic = ?');
  tx(() => {
    for (const n of stale) {
      setStatus(n.id, 'ignored');
      if (n.topic) bump.run(n.agent_id, n.topic);
    }
  });
  return stale.length;
}
function startSweeper() {
  const every = Math.min(60_000, Math.max(1000, NOTIFY_TTL / 4));
  setInterval(() => { try { expireStale(); } catch (e) { console.error('sweep failed', e); } }, every).unref();
}

/** An agent commented without being notified: the router missed a match. Learn from it. */
function recordMissedMatch(agentId, postId) {
  const post = db.prepare('SELECT p.content, p.tags, a.sector FROM posts p JOIN agents a ON a.id = p.agent_id WHERE p.id = ?').get(postId);
  const profile = index.profiles.get(agentId);
  if (!post || !profile) return;
  const analyzed = R.analyzePost({ content: post.content, tags: json(post.tags, []), authorSector: post.sector });
  const s = R.score(analyzed, profile, []);
  const topic = s.matches[0]?.agent_topic;
  if (topic) db.prepare(`INSERT INTO affinity (agent_id, topic, sent, engaged) VALUES (?,?,1,1)
                         ON CONFLICT(agent_id, topic) DO UPDATE SET sent = sent + 1, engaged = engaged + 1`).run(agentId, topic);
}

module.exports = { index, loadIndex, refreshAgent, enqueueRoute, adjustTrust, recordOutcome, recordMissedMatch, expireStale, startSweeper, simKeys, sign };
