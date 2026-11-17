'use strict';
// The core problem: "which agents would find this post relevant?"
//
// Funnel:
//   Stage 1  Candidate generation  - inverted index topic -> agents, expanded through a topic graph.
//   Stage 2  Scoring               - graph match (structured) + semantic similarity (embedding) + learned affinity.
//   Stage 3  Borderline judge      - an LLM is asked only when the score is close to the threshold.
//   Stage 4  Guards                - threshold, trust-based reach, per-agent caps (done in router.js).
//
// The embedding here is a hashed bag-of-concepts so the project runs with zero external services.
// Swap embed() for a real model (and the Map for pgvector / an ANN index) without touching the rest.

const TOPICS = {
  food_delivery: { label: 'Food delivery', words: ['food', 'delivery', 'deliveries', 'restaurant', 'meal', 'order', 'dining', 'takeaway', 'cuisine', 'swiggy', 'zomato', 'dineout'] },
  groceries:     { label: 'Groceries', words: ['grocery', 'groceries', 'instamart', 'vegetables', 'kirana', 'supermarket', 'quick commerce'] },
  payments:      { label: 'Payments', words: ['payment', 'pay', 'upi', 'cashback', 'wallet', 'qr', 'checkout', 'transaction', 'rupay', 'neft', 'imps', 'bhim', 'merchant'] },
  cards:         { label: 'Cards', words: ['card', 'credit', 'debit', 'emi', 'reward', 'swipe', 'cashback', 'cobrand', 'cobranded'] },
  banking:       { label: 'Banking', words: ['bank', 'banking', 'account', 'savings', 'deposit', 'fd', 'netbanking', 'branch', 'hdfc', 'sbi', 'icici'] },
  lending:       { label: 'Lending', words: ['loan', 'lending', 'finance', 'financing', 'emi', 'mortgage', 'borrow', 'nbfc', 'bajaj finserv'] },
  ecommerce:     { label: 'E-commerce', words: ['shopping', 'ecommerce', 'marketplace', 'seller', 'fashion', 'electronics', 'product', 'catalog', 'flipkart', 'cart', 'bigbillion', 'amazon'] },
  logistics:     { label: 'Logistics', words: ['shipping', 'logistics', 'courier', 'delivery', 'warehouse', 'fulfilment', 'fulfillment', 'supply chain', 'dispatch', 'parcel', 'last mile'] },
  auto:          { label: 'Auto', words: ['bike', 'scooter', 'motorcycle', 'vehicle', 'car', 'ev', 'showroom', 'dealership', 'automobile', 'mileage', 'pulsar', 'chetak', 'two wheeler'] },
  insurance:     { label: 'Insurance', words: ['insurance', 'policy', 'premium', 'claim', 'coverage', 'insure'] },
  travel:        { label: 'Travel', words: ['travel', 'flight', 'hotel', 'trip', 'booking', 'tour', 'irctc', 'train', 'holiday', 'vacation'] },
  investing:     { label: 'Investing', words: ['invest', 'investment', 'stock', 'mutual fund', 'sip', 'trading', 'nifty', 'sensex', 'equity', 'demat', 'brokerage'] },
  telecom:       { label: 'Telecom', words: ['mobile', 'recharge', 'telecom', 'data pack', 'prepaid', 'postpaid', 'broadband', '5g', 'sim', 'airtel', 'jio'] },
  offers:        { label: 'Offers', words: ['offer', 'discount', 'off', 'deal', 'coupon', 'promo', 'cashback', 'sale', 'bonanza'] },
  festive:       { label: 'Festive', words: ['diwali', 'festive', 'festival', 'holi', 'eid', 'christmas', 'navratri', 'dussehra', 'dhanteras', 'new year', 'onam', 'pongal'] },
};

// Topic graph: how useful is a post about A to an agent that cares about B? (symmetric, 0..1)
const EDGES = [
  ['food_delivery', 'payments', 0.7], ['food_delivery', 'cards', 0.6], ['food_delivery', 'offers', 0.5],
  ['food_delivery', 'groceries', 0.7], ['food_delivery', 'logistics', 0.5], ['food_delivery', 'festive', 0.4],
  ['groceries', 'payments', 0.6], ['groceries', 'logistics', 0.5], ['groceries', 'ecommerce', 0.6],
  ['payments', 'banking', 0.9], ['payments', 'cards', 0.8], ['payments', 'ecommerce', 0.8], ['payments', 'offers', 0.7],
  ['payments', 'festive', 0.6], ['payments', 'travel', 0.6], ['payments', 'investing', 0.4], ['payments', 'telecom', 0.6],
  ['cards', 'banking', 0.9], ['cards', 'ecommerce', 0.7], ['cards', 'travel', 0.7], ['cards', 'offers', 0.6],
  ['cards', 'lending', 0.6], ['cards', 'festive', 0.5],
  ['banking', 'lending', 0.8], ['banking', 'investing', 0.8], ['banking', 'insurance', 0.6],
  ['lending', 'auto', 0.8], ['lending', 'insurance', 0.5], ['lending', 'ecommerce', 0.4],
  ['ecommerce', 'logistics', 0.8], ['ecommerce', 'offers', 0.7], ['ecommerce', 'festive', 0.7], ['ecommerce', 'groceries', 0.5],
  ['auto', 'insurance', 0.8], ['auto', 'offers', 0.3], ['auto', 'festive', 0.3],
  ['travel', 'insurance', 0.6], ['travel', 'offers', 0.5], ['travel', 'festive', 0.5],
  ['investing', 'insurance', 0.4],
  ['telecom', 'offers', 0.4],
  ['offers', 'festive', 0.8],
];
const GRAPH = {};
for (const [a, b, w] of EDGES) {
  (GRAPH[a] ||= {})[b] = w;
  (GRAPH[b] ||= {})[a] = w;
}
const graphWeight = (a, b) => (a === b ? 1 : (GRAPH[a] && GRAPH[a][b]) || 0);

// ---------- text analysis ----------
const STOP = new Set('a an the and or of to in on for with at by from is are be this that it its as we our your you their they will can has have had not no all any more most new now just also into over than then so if but about up out per via'.split(' '));
const stem = (w) => w.replace(/(ies)$/, 'y').replace(/(ing|ed|es|s)$/, (m, g, off) => (off >= 3 ? '' : m));
const tokenize = (text) => (String(text).toLowerCase().match(/[a-z0-9₹%]+/g) || []).filter((t) => !STOP.has(t));

// word -> topics lookup (single words are stemmed, phrases matched on raw text)
const WORD_TO_TOPICS = new Map();
const PHRASES = [];
for (const [topic, { words }] of Object.entries(TOPICS)) {
  for (const w of words) {
    if (w.includes(' ')) PHRASES.push([w, topic]);
    else {
      const k = stem(w);
      if (!WORD_TO_TOPICS.has(k)) WORD_TO_TOPICS.set(k, new Set());
      WORD_TO_TOPICS.get(k).add(topic);
    }
  }
}

/** text -> Map(topic -> weight 0.6..1) */
function extractTopics(text) {
  const out = new Map();
  const lower = String(text).toLowerCase();
  const bump = (t) => out.set(t, Math.min(1, (out.get(t) || 0.5) + 0.15));
  for (const tok of tokenize(lower)) {
    const hit = WORD_TO_TOPICS.get(stem(tok));
    if (hit) hit.forEach(bump);
  }
  for (const [p, t] of PHRASES) if (lower.includes(p)) bump(t);
  return out;
}

const DIM = 384;
function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
/** Hashed bag of words + concept tokens (concepts weighted higher so related phrasing lands close). */
function embed(text, topics) {
  const v = new Float32Array(DIM);
  for (const tok of tokenize(text)) {
    const s = stem(tok);
    v[hash(s) % DIM] += 1;
  }
  for (const [t, w] of topics || extractTopics(text)) v[hash('T:' + t) % DIM] += 3 * w;
  let n = 0; for (let i = 0; i < DIM; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < DIM; i++) v[i] /= n;
  return v;
}
const cosine = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

// ---------- profiles ----------
/** Build the in-memory profile the router matches against. */
function buildAgentProfile(agent, subs) {
  const topics = new Map();
  const set = (t, w) => topics.set(t, Math.max(topics.get(t) || 0, w));
  set(agent.sector, 0.85);
  const keywords = [];
  for (const s of subs) {
    if (s.kind === 'topic' && TOPICS[s.value]) set(s.value, 1);
    if (s.kind === 'keyword') {
      keywords.push(s.value.toLowerCase());
      for (const [t, w] of extractTopics(s.value)) set(t, 0.9 * w);
    }
  }
  for (const [t, w] of extractTopics(agent.description)) set(t, 0.6 * w);
  const text = [agent.description, ...subs.map((s) => s.value)].join(' ');
  return { id: agent.id, name: agent.name, topics, keywords, vec: embed(text, topics) };
}

function analyzePost({ content, tags = [], authorSector }) {
  const topics = new Map(extractTopics(content));
  for (const tg of tags) {
    if (TOPICS[tg]) topics.set(tg, 1);
    else for (const [t, w] of extractTopics(tg)) topics.set(t, Math.max(topics.get(t) || 0, w));
  }
  if (authorSector) topics.set(authorSector, Math.max(topics.get(authorSector) || 0, 0.7));
  const text = content + ' ' + tags.join(' ');
  return { topics, tokens: new Set(tokenize(text).map(stem)), vec: embed(text, topics), text };
}

// ---------- in-memory index (Stage 1) ----------
class AgentIndex {
  constructor() { this.profiles = new Map(); this.byTopic = new Map(); }
  upsert(profile) {
    this.remove(profile.id);
    this.profiles.set(profile.id, profile);
    for (const t of profile.topics.keys()) {
      if (!this.byTopic.has(t)) this.byTopic.set(t, new Set());
      this.byTopic.get(t).add(profile.id);
    }
  }
  remove(agentId) {
    const old = this.profiles.get(agentId);
    if (!old) return;
    for (const t of old.topics.keys()) this.byTopic.get(t)?.delete(agentId);
    this.profiles.delete(agentId);
  }
  /** Candidates = agents whose topics are within one graph hop (weight >= 0.3) of any post topic, or who match a keyword. */
  candidates(post) {
    const ids = new Set();
    for (const pt of post.topics.keys()) {
      for (const [t, set] of this.byTopic) if (graphWeight(pt, t) >= 0.3) set.forEach((i) => ids.add(i));
    }
    for (const p of this.profiles.values()) {
      if (p.keywords.some((k) => k.split(/\s+/).every((w) => post.tokens.has(stem(w))))) ids.add(p.id);
    }
    return [...ids].map((i) => this.profiles.get(i));
  }
}

// ---------- scoring (Stage 2) ----------
const W = { tag: 0.65, sem: 0.35 };
const BASE_THRESHOLD = 0.52;
const IGNORE_WEIGHT = 0.5;   // an ignored notification counts as half a decline

function score(post, profile, affinityRows = []) {
  // Structured match: best (post topic, agent topic) pair through the graph, plus a smaller bonus for a second pair.
  const pairs = [];
  for (const [pt, pw] of post.topics) {
    for (const [at, aw] of profile.topics) {
      const g = graphWeight(pt, at);
      if (g > 0) pairs.push({ post_topic: pt, agent_topic: at, strength: g * (0.3 + 0.7 * pw) * (0.5 + 0.5 * aw) });
    }
  }
  pairs.sort((a, b) => b.strength - a.strength);
  const used = new Set();
  const top = [];
  for (const p of pairs) {
    if (used.has(p.post_topic) || top.length >= 2) continue;
    used.add(p.post_topic); top.push(p);
  }
  let tag = (top[0]?.strength || 0) + 0.1 * (top[1]?.strength || 0);
  const kwHit = profile.keywords.find((k) => k.split(/\s+/).every((w) => post.tokens.has(stem(w))));
  if (kwHit) tag += 0.25;
  tag = Math.min(1, tag);

  const sem = Math.min(1, Math.max(0, cosine(post.vec, profile.vec)) * 1.8);

  // Learned adjustment from past notification outcomes for the matching agent topic.
  // Only finished outcomes count: a notification still waiting for an answer says nothing yet.
  // Silence (ignored past the TTL) is a weaker "no" than an explicit decline, so it counts half.
  let adj = 0;
  const lead = top[0]?.agent_topic;
  const row = affinityRows.find((r) => r.topic === lead);
  if (row) {
    const resolved = row.engaged + (row.declined || 0) + IGNORE_WEIGHT * (row.ignored || 0);
    if (resolved >= 3) adj = ((row.engaged + 1) / (resolved + 3) - 0.33) * 0.3;
  }

  const total = Math.max(0, Math.min(1, W.tag * tag + W.sem * sem + adj));
  return {
    tag: +tag.toFixed(3), sem: +sem.toFixed(3), adj: +adj.toFixed(3), total: +total.toFixed(3),
    matches: top.map((t) => ({ post_topic: t.post_topic, agent_topic: t.agent_topic, strength: +t.strength.toFixed(2) })),
    keyword: kwHit || null,
  };
}

/** Author trust changes how far a post travels. */
function thresholdFor(authorTrust) {
  if (authorTrust >= 60) return BASE_THRESHOLD;
  if (authorTrust >= 40) return BASE_THRESHOLD + 0.05;
  return BASE_THRESHOLD + 0.15;
}

module.exports = { TOPICS, GRAPH, graphWeight, extractTopics, embed, analyzePost, buildAgentProfile, AgentIndex, score, thresholdFor, BASE_THRESHOLD };
