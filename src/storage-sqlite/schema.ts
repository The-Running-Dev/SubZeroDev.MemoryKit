// Schema 1 (20-contract.md, persisted schemas). Each later migration bumps user_version
// and runs forward-only, in one transaction, when the store opens.

export const SCHEMA_VERSION = 4;

export const MIGRATIONS: readonly string[] = [
  `
CREATE TABLE memories (
  id TEXT PRIMARY KEY, namespace TEXT NOT NULL, key TEXT, kind TEXT NOT NULL,
  content TEXT NOT NULL, content_type TEXT NOT NULL, metadata TEXT NOT NULL,
  provenance TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active','superseded','archived','tombstoned')),
  prior_state TEXT, revision INTEGER NOT NULL CHECK (revision >= 1), actor TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX memories_ns_key ON memories(namespace, key) WHERE key IS NOT NULL;
CREATE INDEX memories_ns_state_updated ON memories(namespace, state, updated_at DESC, id);

CREATE TABLE links (
  source TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE, type TEXT NOT NULL, target TEXT NOT NULL,
  ordinal INTEGER NOT NULL, PRIMARY KEY (source, ordinal)
) STRICT;
CREATE INDEX links_target ON links(target, type);

CREATE VIRTUAL TABLE memories_fts USING fts5(id UNINDEXED, kind, content, metadata_text, tokenize = 'unicode61 remove_diacritics 2');

CREATE TABLE namespaces (name TEXT PRIMARY KEY, history_policy TEXT NOT NULL CHECK (history_policy IN ('full','metadata','none')), created_at TEXT NOT NULL) STRICT;

CREATE TABLE operations (
  principal_id TEXT NOT NULL, operation_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
  memory_id TEXT NOT NULL, revision INTEGER NOT NULL, seq INTEGER, created_at TEXT NOT NULL,
  PRIMARY KEY (principal_id, operation_id)
) STRICT;

CREATE TABLE outbox (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, operation_id TEXT NOT NULL, memory_id TEXT NOT NULL,
  revision INTEGER NOT NULL, operation TEXT NOT NULL, actor TEXT NOT NULL, at TEXT NOT NULL,
  namespace TEXT NOT NULL, policy TEXT NOT NULL, payload TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending','exported','blocked')),
  attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, history_ref TEXT,
  UNIQUE (memory_id, revision, operation)
);
CREATE INDEX outbox_status ON outbox(status, seq);

CREATE TABLE drain_lease (id INTEGER PRIMARY KEY CHECK (id = 1), holder TEXT, token INTEGER NOT NULL, expires_at INTEGER NOT NULL) STRICT;

CREATE TABLE purges (memory_id TEXT PRIMARY KEY, namespace TEXT NOT NULL, principal_id TEXT NOT NULL, operation_id TEXT NOT NULL, at TEXT NOT NULL, report TEXT NOT NULL) STRICT;

CREATE TABLE tokens (token_id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, grants TEXT NOT NULL, secret_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, revoked_at TEXT) STRICT;
`,
  // Schema 2: the outcome an operation returned, as JSON, so a replay can return it.
  `ALTER TABLE operations ADD COLUMN outcome TEXT;`,
  // Schema 3: newest first across namespaces, so a listing reads rows in order instead of
  // sorting the table (S16).
  `CREATE INDEX memories_updated ON memories(updated_at DESC, id);`,
  // Schema 4: the same columns under the Porter stemmer, for retrieve's any-word matching
  // (S17), filled from the current records. search keeps memories_fts.
  `
CREATE VIRTUAL TABLE memories_stem USING fts5(id UNINDEXED, kind, content, metadata_text, tokenize = 'porter unicode61 remove_diacritics 2');
INSERT INTO memories_stem (rowid, id, kind, content, metadata_text) SELECT rowid, id, kind, content, metadata_text FROM memories_fts;
`,
];
