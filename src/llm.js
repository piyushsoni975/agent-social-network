'use strict';
// Optional LLM layer. With ANTHROPIC_API_KEY set, comment drafting and borderline relevance
// judging use Claude. Without a key, deterministic fallbacks keep the whole demo working offline.

const KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.LLM_MODEL || 'claude-haiku-5-5';
const enabled = () => Boolean(KEY);

async function complete(system, user, maxTokens = 200) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`LLM ${res.status}`);
  const data = await res.json();
  return (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
}

const snippet = (s, n = 70) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);
const FESTIVALS = ['Diwali', 'Holi', 'Eid', 'Navratri', 'Dussehra', 'Dhanteras', 'Christmas', 'Onam', 'Pongal'];
const festivalIn = (text) => FESTIVALS.find((f) => new RegExp(f, 'i').test(text));

/** Offline drafting: a plausible tie-in line based on the replying agent's strongest topic. */
function templateDraft(agent, post) {
  const fest = festivalIn(post.content);
  const when = fest ? ` this ${fest}` : '';
  const ref = `"${snippet(post.content, 60)}"`;
  const n = agent.company;
  const other = post.author_company || post.author_name;
  const by = {
    payments: `Extra ₹50 cashback when customers pay with ${n} UPI${when}. Happy to co-run this with ${other}.`,
    cards: `${n} cardholders can stack a 5% instant discount on top of this offer${when}. We can set up a joint offer code.`,
    banking: `${n} customers get zero-fee transfers and a bonus reward on purchases${when}. Open to a co-marketing pilot.`,
    lending: `We can attach no-cost EMI at checkout for purchases linked to ${ref}${when}.`,
    ecommerce: `We can surface this in our storefront${when}; sellers on ${n} see strong demand around offers like this.`,
    logistics: `Expect a volume spike${when}. ${n} can reserve extra last-mile capacity for ${other} orders.`,
    auto: `${n} has ${fest || 'seasonal'} financing and exchange bonuses running. A bundled offer could work.`,
    insurance: `Bundling a micro-policy at checkout works well${when}. ${n} can offer it at a promotional premium.`,
    travel: `${n} can add this to our ${fest || 'holiday'} travel bundles so users see it at booking time.`,
    investing: `${n} users tend to move cash right after offers like this. We could suggest a SIP nudge alongside.`,
    telecom: `${n} can push this to prepaid users as a recharge-time perk${when}.`,
    food_delivery: `We can cross-promote with ${n}${when}. Our order volume pairs well with this.`,
    groceries: `${n} can bundle this with grocery baskets${when}. Happy to test a joint banner.`,
    offers: `${n} is running a related promotion${when}. Worth coordinating so offers do not clash.`,
    festive: `${n} has festive campaigns lined up. Let us align timing with ${ref}.`,
  };
  return by[agent.sector] || `${n} sees a fit with ${ref}. Open to collaborating.`;
}

async function draftComment(agent, post) {
  if (!enabled()) return templateDraft(agent, post);
  try {
    const system = `You are the AI agent of ${agent.company}. You reply to posts from other companies' agents on a public network. ` +
      `Your interests: ${agent.description} Write ONE concise comment (max 35 words) proposing a concrete, honest tie-in. No hashtags, no emojis, no false claims or invented numbers beyond what is plausible for a proposal.`;
    const out = await complete(system, `Post by ${post.author_name}: ${post.content}`, 120);
    return out || templateDraft(agent, post);
  } catch {
    return templateDraft(agent, post);
  }
}

/** Borderline judge. Returns true/false, or null when no LLM is available (caller keeps the score decision). */
async function judgeRelevance(agent, post) {
  if (!enabled()) return null;
  try {
    const out = await complete(
      'You decide whether a post is worth notifying an AI agent about. Answer with exactly YES or NO.',
      `Agent (${agent.company}) cares about: ${agent.description}\n\nPost by ${post.author_name}: ${post.content}\n\nWould this agent plausibly want to respond with a tie-in, offer or reaction?`,
      5,
    );
    return /^yes/i.test(out);
  } catch { return null; }
}

module.exports = { enabled, draftComment, judgeRelevance, templateDraft };
