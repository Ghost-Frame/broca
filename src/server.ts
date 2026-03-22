import { createServer, type ServerResponse, type IncomingMessage } from "node:http";
import { initDb } from "./db.ts";
import { narrate, narrateFromTemplate } from "./narrator.ts";
import { ask } from "./ask.ts";
import { UI_HTML } from "./ui.ts";

const DB_PATH = process.env.DB_PATH ?? "./broca.db";
const HOST = process.env.HOST ?? "0.0.0.0";
const PORT = Number(process.env.PORT ?? 5000);
const AUTH_DISABLED = process.env.BROCA_AUTH === "disabled";
const BROCA_API_KEY = process.env.BROCA_API_KEY;
const CORS_ALLOW_ORIGIN = process.env.CORS_ALLOW_ORIGIN;
const BODY_MAX = 64 * 1024;

// Axon subscription: ingest events automatically
const AXON_URL = process.env.AXON_URL || "";
const AXON_API_KEY = process.env.AXON_API_KEY || "";

if (!BROCA_API_KEY && !AUTH_DISABLED) {
  console.error("FATAL: BROCA_API_KEY not set. Set BROCA_AUTH=disabled to run without auth.");
  process.exit(1);
}

const db = initDb(DB_PATH);

// ============================================================================
// HELPERS
// ============================================================================

function json(res: ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function err(res: ServerResponse, message: string, status = 400) {
  json(res, { error: message }, status);
}

function applyCors(origin: string | undefined, res: ServerResponse) {
  if (!CORS_ALLOW_ORIGIN) return;
  if (CORS_ALLOW_ORIGIN === "*" || origin === CORS_ALLOW_ORIGIN) {
    res.setHeader("Access-Control-Allow-Origin", CORS_ALLOW_ORIGIN === "*" ? "*" : origin ?? CORS_ALLOW_ORIGIN);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Vary", "Origin");
  }
}

function authenticate(req: IncomingMessage): boolean {
  if (AUTH_DISABLED) return true;
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) return false;
  return auth.slice(7) === BROCA_API_KEY;
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const done = (fn: () => void) => { if (!settled) { settled = true; fn(); } };
    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      total += chunk.length;
      if (total > BODY_MAX) { done(() => { req.resume(); reject(new Error("Body too large")); }); return; }
      chunks.push(chunk);
    });
    req.on("end", () => done(() => {
      if (chunks.length === 0) { resolve({}); return; }
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString());
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) { reject(new Error("Must be JSON object")); return; }
        resolve(parsed);
      } catch { reject(new Error("Invalid JSON")); }
    }));
    req.on("error", (e) => done(() => reject(e)));
  });
}

function bounded(v: string | null, fallback: number, min: number, max: number): number {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : fallback;
}

// ============================================================================
// CORE LOGIC
// ============================================================================

async function logAction(
  agent: string,
  service: string,
  action: string,
  payload: Record<string, unknown>,
  axonEventId?: number,
  preNarrate = true,
): Promise<{ id: number; narrative: string | null }> {
  const narrative = preNarrate ? (narrateFromTemplate(action, payload) ?? null) : null;

  const row = db.prepare(
    "INSERT INTO actions (agent, service, action, payload, narrative, axon_event_id) VALUES (?, ?, ?, ?, ?, ?) RETURNING id"
  ).get(agent, service, action, JSON.stringify(payload), narrative, axonEventId ?? null) as { id: number };

  return { id: row.id, narrative };
}

function getActions(opts: {
  agent?: string;
  service?: string;
  action?: string;
  since?: string;
  limit?: number;
  offset?: number;
  narrated_only?: boolean;
}) {
  let query = "SELECT * FROM actions WHERE 1=1";
  const params: Array<string | number> = [];

  if (opts.agent) { query += " AND agent = ?"; params.push(opts.agent); }
  if (opts.service) { query += " AND service = ?"; params.push(opts.service); }
  if (opts.action) { query += " AND action = ?"; params.push(opts.action); }
  if (opts.since) { query += " AND created_at >= ?"; params.push(opts.since); }
  if (opts.narrated_only) { query += " AND narrative IS NOT NULL"; }

  query += " ORDER BY id DESC LIMIT ? OFFSET ?";
  params.push(opts.limit ?? 50, opts.offset ?? 0);

  return (db.prepare(query).all(...params) as any[]).map(r => ({
    ...r,
    payload: JSON.parse(r.payload),
  }));
}

function getStats() {
  const total = (db.prepare("SELECT COUNT(*) as c FROM actions").get() as any).c;
  const narrated = (db.prepare("SELECT COUNT(*) as c FROM actions WHERE narrative IS NOT NULL").get() as any).c;
  const byService = db.prepare("SELECT service, COUNT(*) as count FROM actions GROUP BY service ORDER BY count DESC").all();
  return { total, narrated, by_service: byService };
}

// ============================================================================
// AXON WEBHOOK INGESTION
// Subscribe to Axon and receive events as webhooks pointing back here
// ============================================================================

async function subscribeToAxon() {
  if (!AXON_URL) return;

  const selfUrl = process.env.SELF_URL || `http://localhost:${PORT}`;
  const webhookUrl = `${selfUrl}/ingest`;

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (AXON_API_KEY) headers["Authorization"] = `Bearer ${AXON_API_KEY}`;

  // Subscribe to all channels with wildcard
  for (const channel of ["system", "memory", "tasks", "deploy", "alerts"]) {
    try {
      await fetch(`${AXON_URL}/subscribe`, {
        method: "POST",
        headers,
        body: JSON.stringify({ agent: "broca", channel, webhook_url: webhookUrl }),
        signal: AbortSignal.timeout(5000),
      });
    } catch { /* Axon may not be up yet */ }
  }
  console.log(`Subscribed to Axon at ${AXON_URL}`);
}

// ============================================================================
// HTTP SERVER
// ============================================================================

const server = createServer(async (req, res) => {
  applyCors(req.headers.origin, res);
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

  try {
    const url = new URL(req.url!, `http://${req.headers.host}`);
    const path = url.pathname;

    if (path === "/" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(UI_HTML);
    }

    if (path === "/health" && req.method === "GET") {
      return json(res, { status: "ok", version: "0.1.0", ...getStats() });
    }

    // ---- INGEST from Axon webhook (no auth — Axon pushes here) ----
    if (path === "/ingest" && req.method === "POST") {
      const body = await readBody(req);
      // Axon event shape: { id, channel, source, type, payload, created_at }
      const { id: axonId, source, type, payload } = body as {
        id?: number; channel?: string; source?: string; type?: string; payload?: Record<string, unknown>;
      };
      if (!source || !type) return err(res, "source and type required");
      await logAction(source, source, type, payload ?? {}, axonId);
      return json(res, { ok: true });
    }

    if (!authenticate(req)) return err(res, "Unauthorized", 401);

    // ---- LOG an action directly ----
    if (path === "/actions" && req.method === "POST") {
      const body = await readBody(req);
      const { agent, service, action, payload } = body as {
        agent?: string; service?: string; action?: string; payload?: Record<string, unknown>;
      };
      if (!agent || !service || !action) return err(res, "agent, service, and action required");
      const result = await logAction(agent, service, action, payload ?? {});
      return json(res, result, 201);
    }

    // ---- QUERY actions ----
    if (path === "/actions" && req.method === "GET") {
      const actions = getActions({
        agent: url.searchParams.get("agent") ?? undefined,
        service: url.searchParams.get("service") ?? undefined,
        action: url.searchParams.get("action") ?? undefined,
        since: url.searchParams.get("since") ?? undefined,
        limit: bounded(url.searchParams.get("limit"), 50, 1, 500),
        offset: bounded(url.searchParams.get("offset"), 0, 0, 1e9),
        narrated_only: url.searchParams.get("narrated_only") === "true",
      });
      return json(res, actions);
    }

    // ---- GET single action ----
    const actionMatch = path.match(/^\/actions\/(\d+)$/);
    if (actionMatch && req.method === "GET") {
      const row = db.prepare("SELECT * FROM actions WHERE id = ?").get(parseInt(actionMatch[1], 10)) as any;
      if (!row) return err(res, "Action not found", 404);
      return json(res, { ...row, payload: JSON.parse(row.payload) });
    }

    // ---- NARRATE a single action (LLM fallback if no template) ----
    const narrateMatch = path.match(/^\/actions\/(\d+)\/narrate$/);
    if (narrateMatch && req.method === "GET") {
      const row = db.prepare("SELECT * FROM actions WHERE id = ?").get(parseInt(narrateMatch[1], 10)) as any;
      if (!row) return err(res, "Action not found", 404);

      const payload = JSON.parse(row.payload);
      let narrative = row.narrative;

      if (!narrative) {
        narrative = await narrate(row.agent, row.service, row.action, payload);
        db.prepare("UPDATE actions SET narrative = ? WHERE id = ?").run(narrative, row.id);
      }

      return json(res, { id: row.id, narrative, action: row.action, agent: row.agent, created_at: row.created_at });
    }

    // ---- FEED — human-readable activity feed ----
    // Returns recent actions with narratives, auto-generates for any missing
    if (path === "/feed" && req.method === "GET") {
      const limit = bounded(url.searchParams.get("limit"), 20, 1, 100);
      const offset = bounded(url.searchParams.get("offset"), 0, 0, 1e9);
      const agent = url.searchParams.get("agent") ?? undefined;
      const since = url.searchParams.get("since") ?? undefined;

      const actions = getActions({ agent, since, limit, offset });

      // Fill in missing narratives (template only, fast)
      const feed = actions.map(a => {
        const narrative = a.narrative ?? narrateFromTemplate(a.action, a.payload) ?? `${a.agent} performed ${a.action}`;
        if (!a.narrative && narrative) {
          db.prepare("UPDATE actions SET narrative = ? WHERE id = ?").run(narrative, a.id);
        }
        return {
          id: a.id,
          narrative,
          agent: a.agent,
          service: a.service,
          action: a.action,
          created_at: a.created_at,
        };
      });

      return json(res, feed);
    }

    // ---- NARRATE BULK — translate a batch via LLM ----
    if (path === "/narrate" && req.method === "POST") {
      const body = await readBody(req);
      const ids = body.ids as number[] | undefined;
      if (!ids || !Array.isArray(ids) || ids.length === 0) return err(res, "ids array required");
      if (ids.length > 50) return err(res, "max 50 ids per batch");

      const results: { id: number; narrative: string }[] = [];
      for (const id of ids) {
        const row = db.prepare("SELECT * FROM actions WHERE id = ?").get(id) as any;
        if (!row) continue;
        const payload = JSON.parse(row.payload);
        const narrative = row.narrative ?? await narrate(row.agent, row.service, row.action, payload);
        if (!row.narrative) db.prepare("UPDATE actions SET narrative = ? WHERE id = ?").run(narrative, id);
        results.push({ id, narrative });
      }
      return json(res, results);
    }

    // ---- STATS ----
    if (path === "/stats" && req.method === "GET") {
      return json(res, getStats());
    }

    // ---- ASK — natural language query over the stack ----
    if (path === "/ask" && req.method === "POST") {
      const body = await readBody(req);
      const question = body.question as string | undefined;
      if (!question || typeof question !== "string" || !question.trim()) {
        return err(res, "question (string) required");
      }
      try {
        const result = await ask(question.trim());
        return json(res, result);
      } catch (e: any) {
        return err(res, e.message ?? "Ask failed", 502);
      }
    }

    err(res, "Not found", 404);
  } catch (e) {
    console.error("Unhandled:", e);
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Internal server error" }));
  }
});

server.listen(PORT, HOST, async () => {
  console.log(`Broca running on http://${HOST}:${PORT}`);
  console.log(`Database: ${DB_PATH}`);
  console.log(`Auth: ${AUTH_DISABLED ? "DISABLED" : "enabled"}`);
  await subscribeToAxon();
});
