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
  broca:   { url: process.env.BROCA_SELF_URL || `http://localhost:${process.env.PORT || 5100}`, key: process.env.BROCA_API_KEY || "" },
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

export interface AskPlan {
  service: string;
  method: "GET" | "POST";
  path: string;
  params?: Record<string, string | number>;
  body?: Record<string, unknown>;
}

export interface AskResult {
  answer: string;
  plan: AskPlan;
  raw: unknown;
}

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

async function planQuery(question: string): Promise<AskPlan> {
  const system = `You are a routing agent for an AI agent OS. Given a user question, decide which service API to call to answer it.

${SERVICE_CATALOG}

Respond with ONLY valid JSON matching this schema — no explanation, no markdown:
{"service":"<name>","method":"GET|POST","path":"/...","params":{},"body":null}

Rules:
- Use GET with params for filtering. Use POST with body only for engram /search or /context.
- For time-based questions ("today", "last hour", "recent") use limit=20 and omit since unless you know the exact time.
- If no service fits, use broca /feed.`;

  const raw = await callLLM(system, question);

  // Extract JSON even if model wraps it in markdown
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`LLM returned non-JSON plan: ${raw.slice(0, 200)}`);
  return JSON.parse(match[0]) as AskPlan;
}

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

async function narrateResult(question: string, plan: AskPlan, raw: unknown): Promise<string> {
  const system = "You answer questions about an AI agent system. Be concise, direct, and use plain English. No JSON, no technical terms, no IDs.";
  const user = `User asked: "${question}"

Data from ${plan.service} (${plan.method} ${plan.path}):
${JSON.stringify(raw, null, 2).slice(0, 2000)}

Answer the user's question directly in 1-3 sentences.`;

  return callLLM(system, user);
}

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
