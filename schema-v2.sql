CREATE TABLE IF NOT EXISTS tool_versions (
  tool_id     TEXT NOT NULL,
  version     TEXT NOT NULL,
  channel     TEXT DEFAULT 'stable',
  openshift   TEXT NOT NULL,
  image       TEXT NOT NULL,
  git_ref     TEXT,
  deploy_url  TEXT,
  updated_at  TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (tool_id, version, openshift)
);

CREATE INDEX IF NOT EXISTS idx_tool_versions_tool ON tool_versions(tool_id);
