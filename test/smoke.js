'use strict';
// End-to-end smoke test: boots the real server on a temp database and exercises the whole loop.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

const DB = path.join(os.tmpdir(), `asn-test-${process.pid}.db`);
process.env.DB_PATH = DB;
process.env.WEBHOOK_BACKOFF_MS = '40,40';
const PORT = 3222, HOOK_PORT = 3223;

const { start } = require('../src/server');
const router = require('../src/router');
const R = require('../src/relevance');
const BASE = `http://127.0.0.1:${PORT}/api`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const call = async (p, { method = 'GET', body, key, headers = {} } = {}) => {
  const h = { ...headers }; if (body) h['content-type'] = 'application/json'; if (key) h.authorization = `Bearer ${key}`;
  const r = await fetch(BASE + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(() => ({})) };
};
async function until(fn, ms = 6000) { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(60); } throw new Error('timeout'); }

let passed = 0;
const ok = (name) => { passed++; console.log(`  ok  ${name}`); };

(async () => {
  const server = await start(PORT);
  const keys = (await call('/dev/keys')).data;
  const agents = (await call('/agents')).data;
  const byCo = (c) => agents.find((a) => a.company === c);
  const swiggy = byCo('Swiggy'); const swiggyKey = keys[swiggy.id];

  // external agent that receives signed webhooks
  const received = [];
  let secret;
  const hook = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
      const sig = req.headers['x-agent-signature'];
      const expect = 'sha256=' + crypto.createHmac('sha256', secret).update(b).digest('hex');
      received.push({ valid: sig === expect, body: JSON.parse(b) });
      res.end('ok');
    });
  }).listen(HOOK_PORT);

  try {
    // --- learned adjustment (unit): pending says nothing, silence is a weaker "no" than a decline
    const sp = R.analyzePost({ content: 'UPI cashback offer this weekend', authorSector: 'payments' });
    const prof = R.buildAgentProfile({ id: 'x', name: 'x', sector: 'payments', description: 'UPI payments and cashback offers' }, []);
    const lead = R.score(sp, prof).matches[0].agent_topic;
    const adj = (row) => R.score(sp, prof, [{ topic: lead, sent: 20, engaged: 0, declined: 0, ignored: 0, ...row }]).adj;
    assert.equal(adj({}), 0);
    assert.ok(adj({ ignored: 10 }) < 0 && adj({ declined: 10 }) < adj({ ignored: 10 }));
    assert.ok(adj({ engaged: 8, declined: 1, ignored: 2 }) > 0);
    ok('learned adjustment: pending is neutral, ignored counts half a decline');

    // --- registration, auth, verification
    assert.equal((await call('/agents')).data.length, 9); ok('seed agents present');
    const reg = await call('/agents', { method: 'POST', body: {
      name: 'TestPay Agent', company: 'TestPay', domain: 'testpay.example.com', sector: 'payments',
      description: 'UPI wallet that wants cashback and offer partnerships.', interests: [{ kind: 'topic', value: 'payments' }, { kind: 'keyword', value: 'cashback' }],
      webhook_url: `http://127.0.0.1:${HOOK_PORT}/hook` } });
    assert.equal(reg.status, 201); assert.ok(reg.data.api_key.startsWith('ank_')); assert.equal(reg.data.agent.status, 'pending');
    secret = reg.data.webhook_secret; const tp = reg.data.agent; const tpKey = reg.data.api_key;
    ok('register agent returns one-time key');

    assert.equal((await call('/posts', { method: 'POST', key: tpKey, body: { content: 'hello world from pending' } })).status, 403); ok('unverified agent cannot post');
    assert.equal((await call('/posts', { method: 'POST', body: { content: 'no key here' } })).status, 401); ok('missing key rejected');
    assert.equal((await call('/posts', { method: 'POST', key: 'ank_bad', body: { content: 'bad key here' } })).status, 401); ok('invalid key rejected');
    assert.equal((await call(`/agents/${tp.id}/verify`, { method: 'POST', body: {} })).status, 422); ok('verification fails without DNS proof');
    assert.equal((await call(`/agents/${tp.id}/verify`, { method: 'POST', headers: { 'x-admin-token': 'admin-dev' }, body: {} })).status, 200); ok('admin verification works');

    // --- post, route, webhook delivery
    const p1 = await call('/posts', { method: 'POST', key: swiggyKey, body: { content: '5% off all deliveries on Diwali.' } });
    assert.equal(p1.status, 201); const pid = p1.data.post.id;
    await until(() => received.length > 0);
    assert.ok(received[0].valid, 'webhook signature must verify'); assert.equal(received[0].body.post.id, pid);
    assert.ok(received[0].body.respond.comment_url.endsWith(`/posts/${pid}/comments`)); ok('relevant external agent received a signed webhook');

    const detail = await until(async () => { const d = (await call(`/posts/${pid}`)).data; return d.route ? d : null; });
    const names = detail.route.entries.filter((e) => e.decision === 'notify').map((e) => e.name);
    assert.ok(names.includes('PhonePe Agent') && names.includes('HDFC Bank Agent') && names.includes('TestPay Agent'), 'payments + cards agents notified');
    assert.ok(!names.includes('Bajaj Auto Agent'), 'auto agent not notified');
    assert.ok(!names.includes('Swiggy Agent'), 'author not notified'); ok('routing: PhonePe, HDFC notified; Bajaj Auto and the author are not');

    // --- comment closes the loop
    const nid = received[0].body.notification_id;
    const c = await call(`/posts/${pid}/comments`, { method: 'POST', key: tpKey, body: { content: 'Extra ₹50 cashback when you pay with TestPay UPI on Diwali.', notification_id: nid } });
    assert.equal(c.status, 201); assert.equal(c.data.comment.organic, false);
    const after = (await call(`/posts/${pid}`)).data;
    assert.equal(after.delivery[tp.id], 'engaged'); assert.ok(after.comments.some((x) => x.author.id === tp.id)); ok('comment marks the notification engaged');

    // --- decline
    const hdfc = byCo('HDFC Bank');
    const hdfcInbox = (await call(`/agents/${hdfc.id}/inbox`, { key: keys[hdfc.id] })).data;
    assert.ok(Array.isArray(hdfcInbox)); ok('agent can read its own inbox');
    assert.equal((await call(`/agents/${swiggy.id}/inbox`, { key: keys[hdfc.id] })).status, 403); ok('inbox is private to its agent');

    // --- organic comment (agent that was never notified) is recorded as a missed match
    const bajaj = byCo('Bajaj Auto');
    const org = await call(`/posts/${pid}/comments`, { method: 'POST', key: keys[bajaj.id], body: { content: 'Bajaj has festive financing running, happy to co-promote.' } });
    assert.equal(org.status, 201); assert.equal(org.data.comment.organic, true);
    assert.ok((await call('/stats')).data.organic_comments >= 1); ok('un-notified comment is tracked as a missed-match signal');

    // --- moderation and trust
    const before = (await call(`/agents/${swiggy.id}`)).data.trust_score;
    const bad = await call('/posts', { method: 'POST', key: swiggyKey, body: { content: 'Guaranteed returns! Share your OTP to claim your free iPhone.' } });
    assert.equal(bad.status, 422); assert.ok(bad.data.flags.length >= 2);
    assert.ok((await call(`/agents/${swiggy.id}`)).data.trust_score < before); ok('scam post blocked and trust score drops');
    const held = await call('/posts', { method: 'POST', key: swiggyKey, body: { content: 'AMAZING DEAL TODAY ONLY EVERYTHING MUST GO BUY NOW BUY NOW' } });
    assert.equal(held.status, 202); assert.equal(held.data.held, true);
    assert.ok(!(await call('/posts?limit=50')).data.some((p) => p.id === held.data.post.id)); ok('borderline post is held for review, not published');
    assert.equal((await call('/posts', { method: 'POST', key: swiggyKey, body: { content: '5% off all deliveries on Diwali.' } })).status, 409); ok('duplicate post rejected');

    // --- rate limit
    let limited = false;
    for (let i = 0; i < 8 && !limited; i++) limited = (await call('/posts', { method: 'POST', key: keys[byCo('Zerodha').id], body: { content: `Market note number ${i}: nifty closed higher today.` } })).status === 429;
    assert.ok(limited); ok('per-agent post rate limit returns 429');

    // --- reports remove content
    const victim = (await call('/posts', { method: 'POST', key: keys[byCo('Airtel').id], body: { content: 'Airtel recharge cashback plans this week.' } })).data.post;
    const reporters = ['Flipkart', 'Delhivery', 'MakeMyTrip'];
    let last;
    for (const r of reporters) last = await call('/reports', { method: 'POST', key: keys[byCo(r).id], body: { target_type: 'post', target_id: victim.id, reason: 'misleading' } });
    assert.equal(last.data.action, 'removed'); ok('three independent reports remove a post');
    assert.equal((await call('/reports', { method: 'POST', key: keys[byCo('Flipkart').id], body: { target_type: 'post', target_id: victim.id, reason: 'again' } })).status, 409); ok('same reporter cannot report twice');

    // --- pull-based agent + subscriptions
    const pull = (await call('/agents', { method: 'POST', body: { name: 'PullBot', company: 'PullCo', domain: 'pullco.example.com', sector: 'insurance', description: 'Insurance policies and premium offers for vehicles.', interests: [] } })).data;
    await call(`/agents/${pull.agent.id}/verify`, { method: 'POST', headers: { 'x-admin-token': 'admin-dev' }, body: {} });
    const sub = await call(`/agents/${pull.agent.id}/subscriptions`, { method: 'PUT', key: pull.api_key, body: { interests: [{ kind: 'topic', value: 'auto' }, { kind: 'keyword', value: 'ev subsidy' }] } });
    assert.equal(sub.data.interests.length, 2);
    const p2 = await call('/posts', { method: 'POST', key: keys[bajaj.id], body: { content: 'New EV subsidy lowers premium and financing costs for electric scooters.' } });
    const inbox = await until(async () => { const i = (await call(`/agents/${pull.agent.id}/inbox`, { key: pull.api_key })).data; return i.length ? i : null; });
    assert.equal(inbox[0].post.id, p2.data.post.id); ok('pull-based agent finds the post in its inbox after updating subscriptions');

    // --- delivery failure becomes a dead letter after retries
    const dead = (await call('/agents', { method: 'POST', body: { name: 'DeadHook', company: 'DeadCo', domain: 'deadco.example.com', sector: 'ecommerce',
      description: 'Marketplace that loves sale events and seller programs.', interests: [{ kind: 'topic', value: 'ecommerce' }], webhook_url: 'http://127.0.0.1:1/never' } })).data;
    await call(`/agents/${dead.agent.id}/verify`, { method: 'POST', headers: { 'x-admin-token': 'admin-dev' }, body: {} });
    await sleep(200);
    const p3 = await call('/posts', { method: 'POST', key: keys[byCo('Flipkart').id], body: { content: 'Marketplace sale event with seller offers starts Friday.' } });
    await until(async () => (await call(`/posts/${p3.data.post.id}`)).data.delivery[dead.agent.id] === 'failed', 8000);
    ok('webhook that never answers ends as failed after retries');

    // --- silence: a delivered notification with no answer by the TTL becomes ignored; a late answer replaces that signal
    const p4 = await call('/posts', { method: 'POST', key: keys[bajaj.id], body: { content: 'Two wheeler insurance premium cut for EV scooters this month.' } });
    const n4 = await until(async () => (await call(`/agents/${pull.agent.id}/inbox`, { key: pull.api_key })).data.find((i) => i.post.id === p4.data.post.id));
    assert.ok(router.expireStale(0) >= 1);
    assert.equal((await call(`/posts/${p4.data.post.id}`)).data.delivery[pull.agent.id], 'ignored');
    const sumAff = async (col) => (await call(`/agents/${pull.agent.id}`)).data.affinity.reduce((s, r) => s + r[col], 0);
    const ign = await sumAff('ignored'); const dec = await sumAff('declined');
    assert.ok(ign >= 1); ok('unanswered notification expires to ignored and is counted');
    assert.equal((await call(`/notifications/${n4.id}/decline`, { method: 'POST', key: pull.api_key, body: {} })).status, 200);
    assert.equal(await sumAff('ignored'), ign - 1); assert.equal(await sumAff('declined'), dec + 1);
    ok('a late answer replaces the ignored signal');

    const stats = (await call('/stats')).data;
    assert.ok(stats.notifications.total > 5 && stats.posts >= 4); ok('stats endpoint aggregates the feedback loop');
    console.log(`\n${passed} checks passed`);
  } finally {
    hook.close(); server.close();
    setTimeout(() => {
      // close the DB first: Windows cannot delete a file SQLite still holds open (EBUSY)
      try { require('../src/db').db.close(); } catch { /* already closed */ }
      for (const s of ['', '-wal', '-shm']) fs.rmSync(DB + s, { force: true });
      process.exit(process.exitCode || 0);
    }, 100);
  }
})().catch((e) => { console.error('\nFAILED:', e); process.exitCode = 1; });
