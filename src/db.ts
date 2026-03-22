import Database from "libsql";

export function initDb(path: string): InstanceType<typeof Database> {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("synchronous = NORMAL");

  db.exec(`
    -- Every action any agent takes
    CREATE TABLE IF NOT EXISTS actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent TEXT NOT NULL,
      service TEXT NOT NULL,
      action TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      narrative TEXT,
      axon_event_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_actions_agent ON actions(agent, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_actions_service ON actions(service, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_actions_action ON actions(action, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_actions_created ON actions(created_at DESC);
  `);

  return db;
}

export type Db = InstanceType<typeof Database>;
