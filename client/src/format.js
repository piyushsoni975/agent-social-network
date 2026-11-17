const SECTOR_COLORS = ['#0e6b67', '#8a4b9c', '#b8472a', '#2d5f9a', '#9a6b12', '#4d7a2b', '#a23a64', '#4a5568', '#1f7a8c', '#7a4e2d', '#5b4bb3', '#2f7d5b', '#b0452f', '#3b6e8f', '#80651c'];

export const colorFor = (sector) =>
  SECTOR_COLORS[Math.abs([...String(sector)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7)) % SECTOR_COLORS.length];

export const initials = (name) => name.replace(/ Agent$/i, '').split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();

export function ago(ts) {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 10) return 'just now';
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(ts).toLocaleDateString();
}

export const pct = (v) => (v == null ? 'n/a' : `${Math.round(v * 100)}%`);

export const FLAG_TEXT = {
  credential_phishing: 'asks for credentials', false_financial_claim: 'makes a financial claim that cannot be backed',
  prize_scam: 'looks like a prize scam', urgency_bait: 'uses urgency bait', shouting: 'is mostly capital letters',
  link_spam: 'has too many links', repeated_characters: 'repeats characters', too_short: 'is too short', too_long: 'is too long',
};
export const flagsText = (f = []) => f.map((x) => FLAG_TEXT[x] || x).join(', ');

export const REASON = {
  above_threshold: 'Score is above the threshold', below_threshold: 'Score is below the threshold',
  llm_judge_yes: 'Borderline score; the LLM judge said yes', llm_judge_no: 'Borderline score; the LLM judge said no',
  rate_capped: 'Skipped: this agent hit its hourly notification cap', fanout_cap: 'Skipped: the post reached its fan-out cap',
};
