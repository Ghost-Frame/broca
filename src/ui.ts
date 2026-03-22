export const UI_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Broca</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --bg: #0f0f0f;
    --surface: #1a1a1a;
    --border: #2a2a2a;
    --text: #e8e8e8;
    --muted: #666;
    --accent: #7c6af7;
    --accent-dim: #2d2550;
    --answer: #d4edda;
    --answer-bg: #0d2218;
    --error: #f87171;
    --error-bg: #1f0d0d;
  }

  html, body { height: 100%; background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 15px; }

  .layout { display: flex; flex-direction: column; height: 100vh; max-width: 780px; margin: 0 auto; padding: 0 16px; }

  header { padding: 20px 0 16px; border-bottom: 1px solid var(--border); display: flex; align-items: baseline; gap: 10px; }
  header h1 { font-size: 18px; font-weight: 600; letter-spacing: -0.3px; }
  header span { font-size: 13px; color: var(--muted); }

  .feed { flex: 1; overflow-y: auto; padding: 20px 0 8px; display: flex; flex-direction: column; gap: 18px; }
  .feed:empty::after { content: 'Ask anything about your agent stack.'; color: var(--muted); font-size: 14px; margin-top: 40px; text-align: center; }

  .msg { display: flex; flex-direction: column; gap: 6px; }
  .msg.question .bubble { background: var(--accent-dim); color: #c9c2ff; border-radius: 12px 12px 4px 12px; align-self: flex-end; max-width: 85%; }
  .msg.answer .bubble  { background: var(--answer-bg); color: var(--answer); border-radius: 12px 12px 12px 4px; align-self: flex-start; max-width: 92%; }
  .msg.error .bubble   { background: var(--error-bg); color: var(--error); border-radius: 12px; align-self: flex-start; max-width: 92%; }
  .msg.thinking .bubble { background: var(--surface); color: var(--muted); border-radius: 12px; align-self: flex-start; font-style: italic; }

  .bubble { padding: 10px 14px; line-height: 1.55; font-size: 14.5px; }

  .meta { font-size: 11.5px; color: var(--muted); padding: 0 4px; display: flex; gap: 8px; align-items: center; }
  .msg.question .meta { align-self: flex-end; }
  .meta .service { background: var(--border); border-radius: 4px; padding: 1px 6px; font-family: monospace; }

  .details { font-size: 12px; color: var(--muted); padding: 0 4px; }
  .details summary { cursor: pointer; user-select: none; }
  .details summary:hover { color: var(--text); }
  .details pre { margin-top: 8px; padding: 10px; background: var(--surface); border-radius: 6px; overflow-x: auto; white-space: pre-wrap; word-break: break-all; line-height: 1.5; }

  .input-row { padding: 12px 0 20px; display: flex; gap: 10px; border-top: 1px solid var(--border); }
  textarea { flex: 1; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; color: var(--text); padding: 10px 14px; font-size: 14.5px; font-family: inherit; resize: none; outline: none; line-height: 1.5; min-height: 44px; max-height: 140px; transition: border-color 0.15s; }
  textarea:focus { border-color: var(--accent); }
  textarea::placeholder { color: var(--muted); }

  button { background: var(--accent); border: none; border-radius: 10px; color: white; cursor: pointer; font-size: 14px; font-weight: 500; padding: 0 18px; min-height: 44px; transition: opacity 0.15s; white-space: nowrap; }
  button:hover { opacity: 0.85; }
  button:disabled { opacity: 0.4; cursor: not-allowed; }

  .dot-flashing { display: inline-flex; gap: 4px; align-items: center; padding: 2px 0; }
  .dot-flashing span { width: 6px; height: 6px; background: var(--muted); border-radius: 50%; animation: blink 1.2s infinite; }
  .dot-flashing span:nth-child(2) { animation-delay: 0.2s; }
  .dot-flashing span:nth-child(3) { animation-delay: 0.4s; }
  @keyframes blink { 0%,80%,100% { opacity: 0.2; } 40% { opacity: 1; } }

  .feed-section { margin-top: 8px; }
  .feed-section h2 { font-size: 11px; text-transform: uppercase; letter-spacing: 0.8px; color: var(--muted); margin-bottom: 10px; }
  .event { font-size: 13px; color: var(--muted); padding: 6px 0; border-bottom: 1px solid var(--border); display: flex; gap: 10px; }
  .event:last-child { border-bottom: none; }
  .event .time { white-space: nowrap; font-size: 11.5px; color: #444; min-width: 80px; }
</style>
</head>
<body>
<div class="layout">
  <header>
    <h1>Broca</h1>
    <span>agent OS explorer</span>
  </header>

  <div class="feed" id="feed"></div>

  <div class="input-row">
    <textarea id="input" placeholder="Ask anything — what tasks are blocked? what did loom do today? is engram healthy?" rows="1"></textarea>
    <button id="send">Ask</button>
  </div>
</div>

<script>
const feed = document.getElementById('feed');
const input = document.getElementById('input');
const send = document.getElementById('send');

function timeAgo(iso) {
  const d = new Date(iso.includes('T') ? iso : iso + 'Z');
  const s = Math.floor((Date.now() - d) / 1000);
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s/60) + 'm ago';
  if (s < 86400) return Math.floor(s/3600) + 'h ago';
  return Math.floor(s/86400) + 'd ago';
}

function addMsg(type, content, meta) {
  const div = document.createElement('div');
  div.className = 'msg ' + type;

  const bubble = document.createElement('div');
  bubble.className = 'bubble';

  if (type === 'thinking') {
    bubble.innerHTML = '<div class="dot-flashing"><span></span><span></span><span></span></div>';
  } else {
    bubble.textContent = content;
  }
  div.appendChild(bubble);

  if (meta) {
    const m = document.createElement('div');
    m.className = 'meta';
    if (meta.service) {
      const s = document.createElement('span');
      s.className = 'service';
      s.textContent = meta.service + ' ' + meta.method + ' ' + meta.path;
      m.appendChild(s);
    }
    div.appendChild(m);

    if (meta.raw) {
      const det = document.createElement('details');
      det.className = 'details';
      const sum = document.createElement('summary');
      sum.textContent = 'raw data';
      const pre = document.createElement('pre');
      pre.textContent = JSON.stringify(meta.raw, null, 2);
      det.appendChild(sum);
      det.appendChild(pre);
      div.appendChild(det);
    }
  }

  feed.appendChild(div);
  feed.scrollTop = feed.scrollHeight;
  return div;
}

async function ask(question) {
  addMsg('question', question);
  const thinking = addMsg('thinking');
  send.disabled = true;
  input.disabled = true;

  try {
    const res = await fetch('/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question }),
      signal: AbortSignal.timeout(360000),
    });
    const data = await res.json();
    thinking.remove();

    if (!res.ok) {
      addMsg('error', data.error || 'Something went wrong.');
    } else {
      addMsg('answer', data.answer, { service: data.plan.service, method: data.plan.method, path: data.plan.path, raw: data.raw });
    }
  } catch (e) {
    thinking.remove();
    addMsg('error', e.name === 'TimeoutError' ? 'Timed out — the model is loading, try again in a moment.' : e.message);
  } finally {
    send.disabled = false;
    input.disabled = false;
    input.focus();
  }
}

send.addEventListener('click', () => {
  const q = input.value.trim();
  if (!q) return;
  input.value = '';
  autoResize();
  ask(q);
});

input.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send.click();
  }
});

function autoResize() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 140) + 'px';
}
input.addEventListener('input', autoResize);

// Load recent feed on start
fetch('/feed?limit=8').then(r => r.json()).then(events => {
  if (!events.length) return;
  const section = document.createElement('div');
  section.className = 'feed-section';
  const h = document.createElement('h2');
  h.textContent = 'Recent activity';
  section.appendChild(h);
  events.reverse().forEach(e => {
    const row = document.createElement('div');
    row.className = 'event';
    row.innerHTML = \`<span class="time">\${timeAgo(e.created_at)}</span><span>\${e.narrative || e.action}</span>\`;
    section.appendChild(row);
  });
  feed.appendChild(section);
}).catch(() => {});

input.focus();
</script>
</body>
</html>`;
