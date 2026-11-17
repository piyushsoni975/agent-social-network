'use strict';
// Storage layer. SQLite via Node's built-in node:sqlite (no native build step).
// In production this maps 1:1 to Postgres (+ pgvector for embeddings).
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');

const db = new DatabaseSync(process.env.DB_PATH || 'data.db');
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  company TEXT NOT NULL,
  domain TEXT NOT NULL,              -- company web domain, used for verification
  sector TEXT NOT NULL,              -- primary topic id (food_delivery, payments, ...)
  description TEXT NOT NULL,         -- free text: what this agent cares about
  webhook_url TEXT,                  -- https://... or sim:// for platform-hosted demo agents
  webhook_secret TEXT NOT NULL,
  api_key_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | verified | suspended
  verify_token TEXT NOT NULL,
  trust_score REAL NOT NULL DEFAULT 70,
  created_at INTEGER NOT NULL
);

-- What an agent subscribes to. kind = topic (taxonomy id) | keyword (free text).
CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('topic','keyword')),
  value TEXT NOT NULL,
  UNIQUE(agent_id, kind, value)
);

CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  content TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  topics TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'published',  -- published | held | removed
  flags TEXT NOT NULL DEFAULT '[]',
  route_json TEXT,                           -- explainable routing trace
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at DESC);

CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  parent_id TEXT,
  content TEXT NOT NULL,
  organic INTEGER NOT NULL DEFAULT 0,        -- 1 = agent commented without being notified (missed-match signal)
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id, created_at);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  score REAL NOT NULL,
  topic TEXT,                                -- agent topic that matched (feedback is learned per topic)
  status TEXT NOT NULL DEFAULT 'queued',     -- queued | delivered | engaged | declined | ignored | failed
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  responded_at INTEGER,
  UNIQUE(post_id, agent_id)
);
CREATE INDEX IF NOT EXISTS idx_notif_agent ON notifications(agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notif_status ON notifications(status, created_at);

-- Feedback loop: per agent x topic, how did notifications end? (ignored = no answer before the TTL)
CREATE TABLE IF NOT EXISTS affinity (
  agent_id TEXT NOT NULL,
  topic TEXT NOT NULL,
  sent INTEGER NOT NULL DEFAULT 0,
  engaged INTEGER NOT NULL DEFAULT 0,
  declined INTEGER NOT NULL DEFAULT 0,
  ignored INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (agent_id, topic)
);

CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  reporter_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(target_type, target_id, reporter_id)
);
`);

// Migrations for databases created before a column existed (SQLite has no ADD COLUMN IF NOT EXISTS).
for (const sql of ['ALTER TABLE affinity ADD COLUMN ignored INTEGER NOT NULL DEFAULT 0']) {
  try { db.exec(sql); } catch { /* column already exists */ }
}

const id = (prefix) => `${prefix}_${crypto.randomBytes(5).toString('hex')}`;
const now = () => Date.now();
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

const json = (v, d) => { try { return JSON.parse(v); } catch { return d; } };

function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

module.exports = { db, id, now, sha256, json, tx };
