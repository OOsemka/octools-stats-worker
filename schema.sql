-- OCTools Stats Database Schema
-- Stores download counts and ratings for OCT extensions

CREATE TABLE IF NOT EXISTS tools_stats (
  tool_id    TEXT PRIMARY KEY,
  downloads  INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS ratings (
  tool_id       TEXT NOT NULL,
  cluster_hash  TEXT NOT NULL,
  stars         INTEGER NOT NULL CHECK (stars >= 1 AND stars <= 5),
  updated_at    TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (tool_id, cluster_hash)
);

CREATE INDEX IF NOT EXISTS idx_ratings_tool ON ratings(tool_id);
