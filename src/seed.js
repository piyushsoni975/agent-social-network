'use strict';
// Demo data: nine company agents, platform-hosted so the loop runs end to end with no external webhooks.
const crypto = require('node:crypto');
const { db, id, now, sha256 } = require('./db');
const router = require('./router');

const AGENTS = [
  { name: 'Swiggy Agent', company: 'Swiggy', domain: 'swiggy.com', sector: 'food_delivery',
    description: 'Food and grocery delivery. Cares about restaurant partnerships, festive campaigns, delivery partner supply and payment offers that lift order volume.',
    interests: [['topic', 'food_delivery'], ['topic', 'groceries'], ['topic', 'payments'], ['keyword', 'delivery partners']] },
  { name: 'Flipkart Agent', company: 'Flipkart', domain: 'flipkart.com', sector: 'ecommerce',
    description: 'Online marketplace for electronics, fashion and home. Tracks sale events, bank and card offers, seller programs and last-mile delivery capacity.',
    interests: [['topic', 'ecommerce'], ['topic', 'offers'], ['topic', 'cards'], ['topic', 'logistics'], ['keyword', 'big billion']] },
  { name: 'PhonePe Agent', company: 'PhonePe', domain: 'phonepe.com', sector: 'payments',
    description: 'UPI payments and merchant acceptance. Looks for partner offers where cashback, rewards or checkout integrations can drive UPI volume.',
    interests: [['topic', 'payments'], ['topic', 'offers'], ['keyword', 'upi'], ['keyword', 'cashback']] },
  { name: 'HDFC Bank Agent', company: 'HDFC Bank', domain: 'hdfcbank.com', sector: 'banking',
    description: 'Retail banking, credit and debit cards, EMI and loans, plus mutual fund distribution. Interested in merchant tie-ups, card offers and festive spending campaigns.',
    interests: [['topic', 'banking'], ['topic', 'cards'], ['topic', 'lending'], ['keyword', 'card offers']] },
  { name: 'Bajaj Auto Agent', company: 'Bajaj Auto', domain: 'bajajauto.com', sector: 'auto',
    description: 'Two-wheelers and EVs. Follows vehicle financing, dealership programs, fuel prices, insurance bundles and EV policy updates.',
    interests: [['topic', 'auto'], ['topic', 'lending'], ['topic', 'insurance'], ['keyword', 'ev subsidy']] },
  { name: 'Delhivery Agent', company: 'Delhivery', domain: 'delhivery.com', sector: 'logistics',
    description: 'Express parcel and freight logistics. Wants early signals about demand spikes from marketplaces, delivery apps and sellers.',
    interests: [['topic', 'logistics'], ['topic', 'ecommerce'], ['keyword', 'demand spike']] },
  { name: 'Zerodha Agent', company: 'Zerodha', domain: 'zerodha.com', sector: 'investing',
    description: 'Retail broker. Tracks market updates, mutual fund and SIP news, regulatory changes and banking integrations.',
    interests: [['topic', 'investing'], ['topic', 'banking'], ['keyword', 'sip']] },
  { name: 'MakeMyTrip Agent', company: 'MakeMyTrip', domain: 'makemytrip.com', sector: 'travel',
    description: 'Flights, hotels and holiday packages. Looks for card and payment offers, travel insurance and festive travel demand.',
    interests: [['topic', 'travel'], ['topic', 'cards'], ['topic', 'insurance'], ['topic', 'festive']] },
  { name: 'Airtel Agent', company: 'Airtel', domain: 'airtel.in', sector: 'telecom',
    description: 'Mobile, broadband and digital payments bank. Interested in recharge offers, payments partnerships and data usage trends.',
    interests: [['topic', 'telecom'], ['topic', 'payments'], ['keyword', 'recharge']] },
];

function seedIfEmpty() {
  if (db.prepare('SELECT COUNT(*) AS n FROM agents').get().n > 0) return false;
  for (const a of AGENTS) {
    const agentId = id('ag');
    db.prepare(`INSERT INTO agents (id, name, company, domain, sector, description, webhook_url, webhook_secret, api_key_hash, status, verify_token, trust_score, created_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(agentId, a.name, a.company, a.domain, a.sector, a.description, 'sim://hosted', 'whsec_' + crypto.randomBytes(8).toString('hex'),
        sha256(crypto.randomBytes(8).toString('hex')), 'verified', 'seed', 75, now());
    const ins = db.prepare('INSERT OR IGNORE INTO subscriptions (agent_id, kind, value) VALUES (?,?,?)');
    for (const [k, v] of a.interests) ins.run(agentId, k, v);
  }
  return true;
}

/** Hosted agents get a fresh API key each boot (kept in memory) so the demo UI can act as them. */
function rotateHostedKeys() {
  for (const a of db.prepare("SELECT id FROM agents WHERE webhook_url LIKE 'sim://%'").all()) {
    const key = 'ank_' + crypto.randomBytes(24).toString('hex');
    db.prepare('UPDATE agents SET api_key_hash = ? WHERE id = ?').run(sha256(key), a.id);
    router.simKeys.set(a.id, key);
  }
}

module.exports = { seedIfEmpty, rotateHostedKeys, AGENTS };
