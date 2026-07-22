// ============================================================================
// ASK — natural language query over the agent OS stack
// Takes a question, uses LLM to pick the right service + endpoint,
// makes the call, then narrates the result back in plain English.
// ============================================================================

const LLM_URL = process.env.LLM_URL || "";
const LLM_API_KEY = process.env.LLM_API_KEY || "";
const LLM_MODEL = process.env.LLM_MODEL || "qwen2.5:14b";

// Per-service base URLs and keys (all optional — services are skipped if not configured)
const SERVICES: Record<string, { url: string; key: string }> = {
  chiasm:  { url: process.env.CHIASM_URL  || "", key: process.env.CHIASM_API_KEY  || "" },
  engram:  { url: process.env.ENGRAM_URL  || "", key: process.env.ENGRAM_API_KEY  || "" },
  axon:    { url: process.env.AXON_URL    || "", key: process.env.AXON_API_KEY    || "" },
  loom:    { url: process.env.LOOM_URL    || "", key: process.env.LOOM_API_KEY    || "" },
  soma:    { url: process.env.SOMA_URL    || "", key: process.env.SOMA_API_KEY    || "" },
  thymus:  { url: process.env.THYMUS_URL  || "", key: process.env.THYMUS_API_KEY  || "" },
  // The port fallback must match server.ts's own PORT default (5000). It read
  // 5100 here, so with PORT unset a question routed back to broca itself
  // targeted a port nothing was listening on.
  broca:   { url: process.env.BROCA_SELF_URL || `http://localhost:${process.env.PORT || 5000}`, key: process.env.BROCA_API_KEY || "" },
};

const SERVICE_CATALOG = `
Available services and endpoints (only call what is configured):

chiasm (task tracker):
  GET  /tasks?status=active|blocked|blocked_on_human|completed|paused&agent=X&project=X&limit=N
  GET  /tasks/:id
  GET  /feed?limit=N&offset=N

engram (memory store):
  POST /search   body: {"query":"...","limit":N}
  POST /context  body: {"query":"...","budget":N}

axon (event bus):
  GET  /events?channel=X&limit=N&since=ISO
  GET  /channels

loom (workflow engine):
  GET  /runs?status=running|completed|failed|cancelled&limit=N
  GET  /runs/:id
  GET  /workflows

soma (agent registry):
  GET  /agents?status=online|offline&type=service|agent
  GET  /agents/:id

thymus (evaluations):
  GET  /evaluations?agent=X&limit=N

broca (action log):
  GET  /actions?agent=X&action=X&service=X&limit=N&since=ISO
  GET  /feed?limit=N
  GET  /stats
`.trim();

// Describes the service request selected for a natural-language question.
export interface AskPlan {
  service: string;
  method: "GET" | "POST";
  path: string;
  params?: Record<string, string | number>;
  body?: Record<string, unknown>;
}

// Contains the selected plan, raw service response, and readable answer.
export interface AskResult {
  answer: string;
  plan: AskPlan;
  raw: unknown;
}

// Calls the configured OpenAI-compatible model and returns its text response.
async function callLLM(systemPrompt: string, userPrompt: string): Promise<string> {
  if (!LLM_URL) throw new Error("LLM_URL not configured");

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (LLM_API_KEY) headers["Authorization"] = `Bearer ${LLM_API_KEY}`;

  const isOllama = LLM_URL.includes("11434") || LLM_URL.includes("ollama");
  const url = (isOllama && !LLM_URL.includes("/chat/completions"))
    ? LLM_URL.replace(/\/?$/, "") + "/v1/chat/completions"
    : LLM_URL;

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: LLM_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.2,
      stream: false,
      keep_alive: "10m",
    }),
    signal: AbortSignal.timeout(180000),
  });

  if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);
  const data = await res.json() as any;
  return (data.choices?.[0]?.message?.content ?? data.result ?? data.text ?? "").trim();
}

// Converts a question into a service request using the model or fallback router.
async function planQuery(question: string): Promise<AskPlan> {
  const system = `You are a routing agent for an AI agent OS. Given a user question, decide which service API to call to answer it.

${SERVICE_CATALOG}

Respond with ONLY valid JSON matching this schema — no explanation, no markdown:
{"service":"<name>","method":"GET|POST","path":"/...","params":{},"body":null}

Rules:
- Use GET with params for filtering. Use POST with body only for engram /search or /context.
- For time-based questions ("today", "last hour", "recent") use limit=20 and omit since unless you know the exact time.
- If no service fits, use broca /feed.`;

  // No LLM configured, or the LLM failed: fall back to keyword routing rather
  // than failing the whole request. An unconfigured LLM is the default state
  // on a fresh install, and /ask returning 502 there makes the service look
  // broken on first run.
  if (!LLM_URL) return keywordPlan(question);

  let raw: string;
  try {
    raw = await callLLM(system, question);
  } catch (e) {
    console.error("[ask] planning LLM call failed, using keyword fallback:", (e as Error).message);
    return keywordPlan(question);
  }

  // Extract JSON even if model wraps it in markdown
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) {
    console.error("[ask] LLM returned non-JSON plan, using keyword fallback");
    return keywordPlan(question);
  }
  try {
    return JSON.parse(match[0]) as AskPlan;
  } catch {
    console.error("[ask] LLM plan was not parseable JSON, using keyword fallback");
    return keywordPlan(question);
  }
}

// Route a question to a service by substring match, used whenever the planning
// LLM is unavailable or unusable. Deliberately conservative: it only picks a
// service whose name or an obvious synonym appears in the question, and
// otherwise reads broca's own action feed, which can answer "what happened"
// style questions without any other service being configured.
export function keywordPlan(question: string): AskPlan {
  const q = question.toLowerCase();
  const feed: AskPlan = { service: "broca", method: "GET", path: "/feed", params: { limit: 20 }, body: null };

  const routes: { match: string[]; plan: AskPlan }[] = [
    { match: ["task", "chiasm", "todo", "assigned"], plan: { service: "chiasm", method: "GET", path: "/tasks", params: { limit: 20 }, body: null } },
    { match: ["agent", "soma", "online", "registered"], plan: { service: "soma", method: "GET", path: "/agents", params: {}, body: null } },
    { match: ["workflow", "loom", "run"], plan: { service: "loom", method: "GET", path: "/runs", params: { limit: 20 }, body: null } },
    { match: ["event", "axon", "channel"], plan: { service: "axon", method: "GET", path: "/events", params: { limit: 20 }, body: null } },
    { match: ["quality", "thymus", "score", "evaluation", "drift"], plan: { service: "thymus", method: "GET", path: "/evaluations", params: { limit: 20 }, body: null } },
    { match: ["memory", "remember", "engram", "recall"], plan: { service: "engram", method: "GET", path: "/search", params: { limit: 20 }, body: null } },
  ];

  for (const route of routes) {
    if (route.match.some((word) => q.includes(word))) {
      // Only route to a service that is actually configured; otherwise the
      // request would fail with "service not configured" when broca's own
      // feed could have answered it.
      if (SERVICES[route.plan.service]?.url) return route.plan;
    }
  }
  return feed;
}

// Executes a validated query plan against the configured coordination service.
async function executeplan(plan: AskPlan): Promise<unknown> {
  const svc = SERVICES[plan.service];
  if (!svc?.url) throw new Error(`Service "${plan.service}" not configured`);

  let url = svc.url.replace(/\/$/, "") + plan.path;

  if (plan.method === "GET" && plan.params && Object.keys(plan.params).length > 0) {
    const qs = new URLSearchParams(
      Object.entries(plan.params).map(([k, v]) => [k, String(v)])
    ).toString();
    url += "?" + qs;
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (svc.key) headers["Authorization"] = `Bearer ${svc.key}`;

  const res = await fetch(url, {
    method: plan.method,
    headers,
    body: plan.method === "POST" && plan.body ? JSON.stringify(plan.body) : undefined,
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) throw new Error(`${plan.service} API returned HTTP ${res.status}`);
  return res.json();
}

// Turn a raw API payload into readable text without an LLM. Prefers whatever
// human-readable field each service already provides (broca narrates its own
// actions, chiasm titles its tasks) and falls back to a compact key summary.
export function summarizeWithoutLlm(plan: AskPlan, raw: unknown): string {
  const rows: unknown[] = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as any)?.items) ? (raw as any).items
    : Array.isArray((raw as any)?.events) ? (raw as any).events
    : Array.isArray((raw as any)?.tasks) ? (raw as any).tasks
    : Array.isArray((raw as any)?.agents) ? (raw as any).agents
    : [];

  if (!rows.length) {
    return `No results from ${plan.service} ${plan.path}.`;
  }

  const lines = rows.slice(0, 10).map((row) => {
    const r = row as Record<string, unknown>;
    const text = r.narrative ?? r.title ?? r.summary ?? r.message ?? r.name ?? r.action ?? r.type;
    return text ? `- ${String(text)}` : `- ${Object.keys(r).slice(0, 4).map((k) => `${k}=${String(r[k])}`).join(" ")}`;
  });

  const more = rows.length > 10 ? `\n(and ${rows.length - 10} more)` : "";
  return `${rows.length} result(s) from ${plan.service} ${plan.path}:\n${lines.join("\n")}${more}`;
}

// Produces a concise answer from a service payload with deterministic fallback.
async function narrateResult(question: string, plan: AskPlan, raw: unknown): Promise<string> {
  // Without an LLM, return a deterministic summary instead of failing. The
  // caller still gets the plan and the raw payload either way.
  if (!LLM_URL) return summarizeWithoutLlm(plan, raw);

  const system = "You answer questions about an AI agent system. Be concise, direct, and use plain English. No JSON and no technical jargon, but DO cite the id of any action you refer to, in parentheses, like (id:42).";
  const user = `User asked: "${question}"

Data from ${plan.service} (${plan.method} ${plan.path}):
${JSON.stringify(raw, null, 2).slice(0, 2000)}

Answer the user's question directly in 1-3 sentences.`;

  try {
    return await callLLM(system, user);
  } catch (e) {
    console.error("[ask] summarising LLM call failed, using plain summary:", (e as Error).message);
    return summarizeWithoutLlm(plan, raw);
  }
}

// Plans, executes, and narrates one natural-language coordination query.
export async function ask(question: string): Promise<AskResult> {
  console.log("[ask] planning query:", question);
  const plan = await planQuery(question);
  console.log("[ask] plan:", JSON.stringify(plan));
  const raw = await executeplan(plan);
  console.log("[ask] got raw result, narrating...");
  const answer = await narrateResult(question, plan, raw);
  console.log("[ask] done");
  return { answer, plan, raw };
}
