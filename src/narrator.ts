// ============================================================================
// NARRATOR — converts raw action payloads into plain English sentences
// Template-first, LLM fallback for unknowns
// ============================================================================

// LLM for fallback narration — supports Ollama, OpenAI-compat, or Engram-style endpoints
const LLM_URL = process.env.LLM_URL || process.env.ENGRAM_URL || "";
const LLM_API_KEY = process.env.LLM_API_KEY || process.env.ENGRAM_API_KEY || "";
const LLM_MODEL = process.env.LLM_MODEL || "qwen2.5:14b";

// Template registry: action -> (payload) -> string
type Template = (p: Record<string, unknown>) => string;

const templates: Record<string, Template> = {
  // ---- Chiasm / tasks ----
  "task.created":         p => `${p.agent || p.source || "An agent"} started a new task: "${p.title}" in ${p.project}`,
  "task.updated":         p => `"${p.title}" status is now ${humanStatus(p.status)}${p.summary ? ` — ${p.summary}` : ""}`,
  "task.completed":       p => `"${p.title || p.task_title}" was completed${p.agent ? ` by ${p.agent}` : ""}`,
  "task.blocked":         p => `"${p.title}" is blocked${p.reason ? `: ${p.reason}` : ""}`,
  "task.blocked_on_human": p => `"${p.title}" is waiting for human approval${p.summary ? `: ${p.summary}` : ""}`,
  "task.feedback":        p => `Human feedback on "${p.title}": "${p.feedback}"`,
  "task.output":          p => `Output submitted for "${p.title}"`,
  "task.plan":            p => `A plan was generated for "${p.title}"`,

  // ---- Loom / workflows ----
  "workflow.run.created":    p => `${p.agent || "An agent"} started the "${p.workflow}" workflow`,
  "workflow.run.completed":  p => `The "${p.workflow}" workflow finished successfully`,
  "workflow.run.failed":     p => `The "${p.workflow}" workflow failed on step "${p.failed_step}"${p.error ? `: ${p.error}` : ""}`,
  "workflow.run.cancelled":  p => `The "${p.workflow}" workflow was cancelled`,
  "workflow.step.started":   p => `Step "${p.step}" started in the "${p.workflow}" workflow`,
  "workflow.step.completed": p => `Step "${p.step}" finished in the "${p.workflow}" workflow`,
  "workflow.step.failed":    p => `Step "${p.step}" failed in the "${p.workflow}" workflow: ${p.error}`,

  // ---- Soma / agents ----
  "agent.registered":    p => `${p.name} came online as a ${p.type}`,
  "agent.deregistered":  p => `${p.name} went offline`,
  "agent.online":        p => `${p.agent || p.name} is online`,
  "agent.offline":       p => `${p.agent || p.name} went offline`,
  "agent.heartbeat":     p => `${p.agent || p.name} checked in`,
  "agent.error":         p => `${p.agent || p.name} reported an error: ${p.error}`,

  // ---- Engram / memory ----
  "memory.stored":   p => `${p.source || "An agent"} stored a memory${p.category ? ` (${p.category})` : ""}${p.content_preview ? `: "${String(p.content_preview).slice(0, 80)}${String(p.content_preview).length > 80 ? "…" : ""}"` : ""}`,
  "memory.searched": p => `${p.agent || "An agent"} searched memory for "${p.query}"${p.results !== undefined ? ` — ${p.results} result${p.results === 1 ? "" : "s"}` : ""}`,
  "memory.linked":   p => `Two memories were linked together`,
  "memory.forgotten": p => `A memory was removed`,

  // ---- Thymus / evaluations ----
  "evaluation.completed": p => {
    const pct = p.overall_score !== undefined ? ` — scored ${Math.round(Number(p.overall_score) * 100)}%` : "";
    return `${p.agent}'s work on "${p.subject}" was evaluated${pct} using the ${p.rubric} rubric`;
  },
  "metric.recorded": p => `${p.agent} recorded ${p.metric}: ${p.value}`,

  // ---- Axon / system ----
  "system.started":   p => `${p.service || "A service"} started up`,
  "system.stopped":   p => `${p.service || "A service"} shut down`,
  "deploy.started":   p => `Deployment started${p.service ? ` for ${p.service}` : ""}`,
  "deploy.succeeded": p => `${p.service || "Deployment"} deployed successfully`,
  "deploy.failed":    p => `Deployment failed${p.service ? ` for ${p.service}` : ""}${p.error ? `: ${p.error}` : ""}`,
  "deploy.rolled_back": p => `${p.service || "Deployment"} was rolled back`,
  "alert.triggered":  p => `Alert triggered: ${p.message || p.name || "unknown"}`,
};

function humanStatus(status: unknown): string {
  const map: Record<string, string> = {
    active: "active",
    paused: "paused",
    blocked: "blocked",
    completed: "done",
    blocked_on_human: "waiting for a human",
    running: "running",
    failed: "failed",
    cancelled: "cancelled",
  };
  return map[String(status)] ?? String(status);
}

export function narrateFromTemplate(action: string, payload: Record<string, unknown>): string | null {
  const fn = templates[action];
  if (!fn) return null;
  try {
    return fn(payload);
  } catch {
    return null;
  }
}

export async function narrateWithLLM(
  agent: string,
  service: string,
  action: string,
  payload: Record<string, unknown>
): Promise<string> {
  if (!LLM_URL) {
    return `${agent} performed ${action} on ${service}`;
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (LLM_API_KEY) headers["Authorization"] = `Bearer ${LLM_API_KEY}`;

  const userPrompt = `Convert this agent action into a single plain English sentence a non-technical person would understand. Be concise and natural. No technical jargon, no IDs, no JSON terms.

Agent: ${agent}
Service: ${service}
Action: ${action}
Details: ${JSON.stringify(payload, null, 2)}

Respond with only the sentence, nothing else.`;

  const system = "You translate technical agent actions into plain English. One sentence only.";

  // Detect endpoint style
  const isOllama = LLM_URL.includes("11434") || LLM_URL.includes("ollama");
  const isOpenAICompat = LLM_URL.includes("/v1/chat") || LLM_URL.includes("/chat/completions");

  try {
    let body: string;
    let url = LLM_URL;

    if (isOllama || isOpenAICompat) {
      // OpenAI-compat format
      if (isOllama && !LLM_URL.includes("/chat/completions")) {
        url = LLM_URL.replace(/\/?$/, "") + "/v1/chat/completions";
      }
      body = JSON.stringify({
        model: LLM_MODEL,
        messages: [
          { role: "system", content: system },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.3,
        stream: false,
        keep_alive: "10m",
      });
    } else {
      // Engram-style /llm endpoint
      body = JSON.stringify({ prompt: userPrompt, system });
    }

    const res = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json() as any;
    // OpenAI-compat response
    const text = data.choices?.[0]?.message?.content
      ?? data.result ?? data.text ?? data.content;
    return text?.trim() ?? `${agent} performed ${action} on ${service}`;
  } catch {
    return `${agent} performed ${action} on ${service}`;
  }
}

export async function narrate(
  agent: string,
  service: string,
  action: string,
  payload: Record<string, unknown>
): Promise<string> {
  const fromTemplate = narrateFromTemplate(action, payload);
  if (fromTemplate) return fromTemplate;
  return narrateWithLLM(agent, service, action, payload);
}
