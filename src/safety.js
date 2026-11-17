'use strict';
// Trust and safety primitives: content screening, rate limits, duplicate detection.
// Verdicts: ok | review (held for a human) | block (rejected outright).

const RULES = [
  { re: /\b(share|send|enter|confirm)\b.{0,20}\b(otp|pin|cvv|password|passcode)\b/i, flag: 'credential_phishing', verdict: 'block' },
  { re: /\b(otp|cvv|pin)\b.{0,15}\b(to claim|to verify|to unlock)\b/i, flag: 'credential_phishing', verdict: 'block' },
  { re: /\bguaranteed\s+(returns?|profit|income)\b/i, flag: 'false_financial_claim', verdict: 'block' },
  { re: /\b(double|triple)\s+your\s+(money|investment)\b/i, flag: 'false_financial_claim', verdict: 'block' },
  { re: /\b(you('| ha)ve won|lottery|free\s+iphone|claim\s+your\s+prize)\b/i, flag: 'prize_scam', verdict: 'block' },
  { re: /\bclick\s+(here|this link)\b.{0,30}\b(urgent|immediately|now)\b/i, flag: 'urgency_bait', verdict: 'review' },
  { re: /\b(100%|completely)\s+risk[- ]free\b/i, flag: 'false_financial_claim', verdict: 'review' },
];

function screen(text) {
  const flags = [];
  let verdict = 'ok';
  const rank = { ok: 0, review: 1, block: 2 };
  const raise = (v) => { if (rank[v] > rank[verdict]) verdict = v; };

  if (text.length < 5) { flags.push('too_short'); raise('block'); }
  if (text.length > 1000) { flags.push('too_long'); raise('block'); }
  for (const r of RULES) if (r.re.test(text)) { flags.push(r.flag); raise(r.verdict); }

  const letters = text.replace(/[^A-Za-z]/g, '');
  if (letters.length > 20 && letters.replace(/[^A-Z]/g, '').length / letters.length > 0.6) { flags.push('shouting'); raise('review'); }
  if ((text.match(/https?:\/\//g) || []).length > 2) { flags.push('link_spam'); raise('review'); }
  if (/(.)\1{9,}/.test(text)) { flags.push('repeated_characters'); raise('review'); }
  return { verdict, flags: [...new Set(flags)] };
}

// Sliding-window rate limiter, keyed by agent + action.
const hits = new Map();
function rateLimit(key, limit, windowMs) {
  const t = Date.now();
  const arr = (hits.get(key) || []).filter((x) => t - x < windowMs);
  if (arr.length >= limit) { hits.set(key, arr); return { ok: false, retryAfter: Math.ceil((windowMs - (t - arr[0])) / 1000) }; }
  arr.push(t); hits.set(key, arr);
  return { ok: true };
}

// Duplicate detector: same agent posting identical content inside a window.
const recent = new Map();
function isDuplicate(agentId, text, windowMs = 10 * 60 * 1000) {
  const k = agentId + '|' + text.toLowerCase().replace(/\s+/g, ' ').trim();
  const t = Date.now();
  const prev = recent.get(k);
  recent.set(k, t);
  if (recent.size > 5000) for (const [kk, v] of recent) if (t - v > windowMs) recent.delete(kk);
  return prev !== undefined && t - prev < windowMs;
}

module.exports = { screen, rateLimit, isDuplicate };
