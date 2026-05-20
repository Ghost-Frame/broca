# Broca

Broca is an agent action log and natural language narrator. It records what every agent in your system did, then translates raw events into human-readable narratives so you can read your stack like a story. Subscribe it to Axon to ingest events automatically, log actions directly via HTTP, or ask plain-English questions about recent activity.

- **Port:** 5000
- **Stack:** Node 22, libsql (SQLite-compatible embedded database)

---

## What It Does

- Stores every agent action with agent, service, action type, and arbitrary payload
- Generates template-based narratives synchronously on ingest, LLM-based on demand
- Subscribes to Axon channels and ingests events automatically via webhook
- Exposes a human-readable activity feed across all agents
- Answers natural language questions about recent activity via `/ask`
- Tracks aggregate stats: total actions, narration coverage, top services/agents/actions

---

## Quick Start

```bash
docker run -d \
  --name broca \
  -p 5000:5000 \
  -e BROCA_API_KEY=your-secret-key \
  -e DB_PATH=/data/broca.db \
  -v broca-data:/data \
  ghcr.io/ghost-frame/broca:latest
```

Without `BROCA_AUTH=disabled`, all authenticated endpoints require `Authorization: Bearer <BROCA_API_KEY>`. The `/ingest` webhook endpoint is intentionally unauthenticated so Axon (or any upstream source) can push events to it -- gate it at the network layer if needed.

A minimal browser UI is served at `/` for inspecting the action log live.

---

## Environment Variables

| Variable            | Default     | Description                                                        |
|---------------------|-------------|--------------------------------------------------------------------|
| `PORT`              | `5000`      | Port to listen on                                                  |
| `HOST`              | `0.0.0.0`   | Bind address                                                       |
| `DB_PATH`           | `broca.db`  | Path to the libsql database file                                   |
| `BROCA_API_KEY`     | (none)      | Bearer token required for authenticated requests                   |
| `BROCA_AUTH`        | (required)  | Set to `disabled` to skip auth entirely (development only)         |
| `CORS_ALLOW_ORIGIN` | (none)      | Value for the `Access-Control-Allow-Origin` response header        |
| `AXON_URL`          | (none)      | If set, subscribes to Axon at this URL on startup                  |
| `AXON_API_KEY`      | (none)      | Bearer token for Axon subscribe calls                              |
| `SELF_URL`          | `http://localhost:$PORT` | Public URL Axon uses to call back to `/ingest`        |

---

## Concepts

- **Action** -- a single recorded event with `agent`, `service`, `action`, and `payload`
- **Narrative** -- a human-readable sentence describing the action, generated from a template on ingest or via LLM on demand
- **Feed** -- the chronological activity stream with narratives filled in
- **Ask** -- natural language query that scans recent actions and returns a synthesized answer

---

## API Reference

### Health

#### `GET /health`

Returns service status and aggregate stats.

```json
{
  "status": "ok",
  "version": "0.1.0",
  "total": 1042,
  "narrated": 1042,
  "by_service": [{ "service": "memory", "count": 502 }],
  "by_agent": [{ "agent": "claude-code", "count": 320 }],
  "by_action": [{ "action": "memory.store", "count": 410 }]
}
```

---

### Actions

#### `POST /actions`

Log a single action directly. Authenticated.

**Request**
```json
{
  "agent": "claude-code",
  "service": "memory",
  "action": "memory.store",
  "payload": { "content": "...", "tags": ["session"] }
}
```

**Response** `201`
```json
{
  "id": 1042,
  "agent": "claude-code",
  "service": "memory",
  "action": "memory.store",
  "payload": { "content": "...", "tags": ["session"] },
  "narrative": "claude-code stored a new memory",
  "axon_event_id": null,
  "created_at": "2026-03-22T12:00:00Z"
}
```

A template-based narrative is generated synchronously when one exists for the action type.

---

#### `GET /actions`

Query recent actions. Authenticated.

**Query params**
- `agent` -- filter by agent name
- `service` -- filter by service name
- `action` -- filter by action type
- `since` -- ISO8601 timestamp lower bound
- `narrated_only` -- `true` to return only actions with a narrative
- `limit` -- default `50`, max `500`
- `offset` -- pagination offset

**Response** `200` -- array of action objects.

---

#### `GET /actions/:id`

Get a single action by ID. Authenticated.

---

#### `GET /actions/:id/narrate`

Get the narrative for a single action. Generates one via LLM if no template matched on ingest, then persists it. Authenticated.

**Response** `200`
```json
{
  "id": 1042,
  "narrative": "claude-code stored a new memory tagged session",
  "action": "memory.store",
  "agent": "claude-code",
  "created_at": "2026-03-22T12:00:00Z"
}
```

---

#### `POST /narrate`

Bulk-narrate a batch of actions via LLM. Max 50 IDs per call. Authenticated.

**Request**
```json
{ "ids": [1042, 1043, 1044] }
```

**Response** `200`
```json
[
  { "id": 1042, "narrative": "..." },
  { "id": 1043, "narrative": "..." }
]
```

---

### Feed

#### `GET /feed`

Human-readable activity stream. Auto-fills missing narratives from templates. Authenticated.

**Query params**
- `agent` -- filter by agent name
- `since` -- ISO8601 timestamp lower bound
- `limit` -- default `20`, max `100`
- `offset` -- pagination offset

**Response** `200`
```json
[
  {
    "id": 1042,
    "narrative": "claude-code stored a new memory",
    "agent": "claude-code",
    "service": "memory",
    "action": "memory.store",
    "created_at": "2026-03-22T12:00:00Z"
  }
]
```

---

### Ask

#### `POST /ask`

Natural language query over recent actions. Authenticated.

**Request**
```json
{ "question": "What did claude-code do in the last hour?" }
```

**Response** `200` -- synthesized answer with cited action IDs.

---

### Ingest (Axon webhook)

#### `POST /ingest`

Receives Axon webhook events. **Unauthenticated** by design -- protect at the network layer. Set `AXON_URL` to have Broca subscribe to Axon on startup and receive events automatically.

**Request** (Axon event shape)
```json
{
  "id": 9001,
  "channel": "memory",
  "source": "kleos",
  "type": "memory.store",
  "payload": { "...": "..." },
  "created_at": "2026-03-22T12:00:00Z"
}
```

**Response** `200`
```json
{ "ok": true }
```

---

### Stats

#### `GET /stats`

Returns the same aggregate counts as `/health`.

---

## Where Broca Fits

Broca is one piece of a larger agent infrastructure. Sister services:

- [axon](https://github.com/Ghost-Frame/axon) -- pub/sub event bus
- [chiasm](https://github.com/Ghost-Frame/chiasm) -- task coordination dashboard
- [loom](https://github.com/Ghost-Frame/loom) -- workflow orchestration
- [soma](https://github.com/Ghost-Frame/soma) -- agent registry and heartbeats
- [thymus](https://github.com/Ghost-Frame/thymus) -- output evaluation and quality scoring

Broca runs standalone -- no upstream service is required -- but pairs naturally with Axon for zero-config event ingestion.
