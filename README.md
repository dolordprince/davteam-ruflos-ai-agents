# DAVTEAM RUFLOS AI AGENTS

**Production HTTP backend + Osiri frontend intelligence layer around the real [Ruflo](https://github.com/ruvnet/ruflo) runtime.**

```
Browser / Osiri Frontend
        |
        | HTTPS
        v
DavTeam Ruflos API
        |
        v
Ruflo Runtime (v3.45.0)
        |
        +---- Agents
        +---- Swarms
        +---- MCP
        +---- Memory
        +---- Router
        +---- Tools
        +---- Plugins
        +---- MetaHarness
        +---- Model Providers
```

---

## What is DavTeam Ruflos AI Agents?

DavTeam Ruflos AI Agents is a production deployment of the open-source **Ruflo** agent meta-harness, wrapped in a clean HTTP API and a frontend intelligence layer called **Osiri**.

This project does **not** reimplement Ruflo. It depends on the real `ruflo@3.45.0` npm package and exposes its genuine runtime — CLI, MCP server, 100+ specialized agents, swarm orchestration, self-learning memory, neural/model routing, hooks, plugins, security controls, MetaHarness, doctor, and verification — through an additional HTTP API and a browser UI.

## Upstream Attribution

- **Upstream project:** Ruflo by RuvNet
- **Upstream repository:** https://github.com/ruvnet/ruflo
- **Upstream npm package:** `ruflo`
- **Ruflo version:** **3.45.0** (latest stable on npm at build time)
- **Upstream license:** MIT — preserved verbatim in this repository (see `LICENSE`)

The DavTeam additions (HTTP backend, Osiri frontend, Docker config) are MIT licensed and clearly separated from upstream code. No ownership of upstream Ruflo source is claimed.

---

## Architecture

| Layer | Description |
|-------|-------------|
| **Osiri Frontend** | Keyless browser UI — conversation, task execution, agent activity, terminal, tools, memory, files, build/test status. Connects only to the DavTeam backend URL. |
| **DavTeam API** | Production Express HTTP server wrapping the real Ruflo runtime. Handles streaming (SSE/WebSocket), workspace security, command execution, structured logging, error handling. |
| **Ruflo Runtime** | The real `ruflo@3.45.0` — invoked via subprocess. Agents, swarms, MCP, memory, neural routing, security, MetaHarness. |
| **Model Providers** | OpenAI-compatible provider abstraction. Credentials are server-side only. |

### Keyless Architecture

Provider credentials (API keys, tokens) are **never** exposed to the browser:

- No secrets in JavaScript bundles, HTML, or localStorage
- No secrets in API responses
- Credentials are configured server-side via environment variables / Hugging Face Secrets
- The public client only needs the backend URL: `https://YOUR-SPACE.hf.space`

---

## Installation

### Prerequisites

- Node.js >= 20
- npm

### Install

```bash
npm install
```

> The install uses `--omit=optional --ignore-scripts` by default to avoid OOM on heavy native optional dependencies (better-sqlite3, agentdb, ruvector) that Ruflo degrades gracefully without. If you need those subsystems, run `npm install` without those flags on a machine with sufficient memory.

### Verify

```bash
node --version
npm --version
node node_modules/ruflo/bin/ruflo.js --version    # → ruflo v3.45.0
node node_modules/ruflo/bin/ruflo.js doctor --component metaharness
```

---

## Development

```bash
# Start the API server (serves frontend + API)
npm run dev

# Build the frontend
npm run build:frontend

# Run the test suite
npm test
```

## Production Start

```bash
# Set environment variables (see .env.example)
export PORT=7860
export HOST=0.0.0.0
export MODEL_API_KEY=your-server-side-key

npm start
```

---

## Environment Variables

See `.env.example` for the full list. Key variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `7860` | HTTP server port (Hugging Face requires 7860) |
| `HOST` | `0.0.0.0` | Bind address |
| `WORKSPACE` | `./workspace` | Controlled filesystem directory for agents/tools |
| `MODEL_BASE_URL` | `https://api.openai.com/v1` | OpenAI-compatible endpoint |
| `MODEL_NAME` | `gpt-4o` | Model name |
| `MODEL_API_KEY` | (empty) | **Server-side only.** Never exposed to frontend. |
| `ANTHROPIC_API_KEY` | (empty) | Optional — server-side only |
| `OPENAI_API_KEY` | (empty) | Optional — server-side only |
| `GOOGLE_API_KEY` | (empty) | Optional — server-side only |
| `MCP_GROUP_AGENTS` | `true` | Enable agent MCP tools |
| `MCP_GROUP_MEMORY` | `true` | Enable memory MCP tools |
| `MCP_GROUP_DEVTOOLS` | `true` | Enable dev tools |
| `DAVTEAM_API_TOKEN` | (empty) | Optional API auth token |
| `LOG_LEVEL` | `info` | Log level |

---

## API Endpoints

### Health & Version

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Application health (real status) |
| GET | `/api/health` | Detailed health with capabilities |
| GET | `/api/version` | Version info |
| GET | `/api/capabilities` | Actual enabled capabilities |
| GET | `/api/models` | Available models (no keys exposed) |

### Chat & Agents

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/chat` | Direct model chat (server-side credentials) |
| POST | `/api/agent/run` | Run a real agent task |
| POST | `/api/agent/stream` | Start streaming agent task (SSE) |
| GET | `/api/agent/stream` | Subscribe to task events (SSE) |
| GET | `/api/agents` | List active agents |
| POST | `/api/agents/spawn` | Spawn a new agent |

### Tasks & Swarm

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/task` | Create and run a task |
| GET | `/api/tasks/:id` | Get task status |
| POST | `/api/swarm` | Start a swarm |
| GET | `/api/swarm/:id` | Get swarm status |

### Memory

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/memory/search` | Semantic memory search |
| POST | `/api/memory/store` | Store memory entry |

### Tools

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/tools` | List MCP tools |
| POST | `/api/tools/execute` | Execute an MCP tool |

### MetaHarness

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/metaharness/status` | MetaHarness availability (honest) |
| POST | `/api/metaharness/score` | Score |
| POST | `/api/metaharness/genome` | Genome |
| POST | `/api/metaharness/audit` | OIA audit |
| POST | `/api/metaharness/mcp-scan` | MCP scan |
| POST | `/api/metaharness/threat-model` | Threat model |
| POST | `/api/metaharness/similarity` | Similarity |

### Build / Test / Command

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/build` | Run a build task |
| POST | `/api/test` | Run a test task |
| POST | `/api/command` | Execute a validated command |

---

## Osiri Architecture

Osiri is the frontend intelligence/orchestration assistant that communicates with the Ruflo backend:

```
USER → OSIRI → (understand intent, choose Ruflo capability) → RUFLO → (agents/swarm/tools/memory/model) → RESULT → OSIRI → USER
```

Osiri is **not** a hard-coded chatbot. It:
- Understands natural-language tasks
- Creates coding/build tasks via the API
- Invokes Ruflo agents
- Streams real progress events
- Displays tool activity, terminal output, generated files, and errors
- Maintains conversation context
- Reports actual execution results (never fakes success)

---

## Model Provider Configuration

The backend proxies model requests through Ruflo's model routing and an OpenAI-compatible abstraction:

```bash
MODEL_BASE_URL=https://api.openai.com/v1
MODEL_NAME=gpt-4o
MODEL_API_KEY=sk-...   # server-side only, never in frontend
```

Supported providers (all credentials server-side):
- OpenAI-compatible endpoints
- Anthropic (Claude)
- OpenAI (GPT)
- Google (Gemini)
- Transformers.js (local embeddings — no key needed)

---

## Hugging Face Deployment

This repository is prepared for Hugging Face Spaces (Docker-based).

1. Create a new Hugging Face Space (SDK: Docker)
2. Push this repository to the Space
3. Configure secrets in Space Settings → Repository Secrets:
   - `MODEL_API_KEY` (and optionally `ANTHROPIC_API_KEY`, etc.)
4. The Space builds from the `Dockerfile` and starts on port 7860
5. Access at `https://YOUR-SPACE.hf.space`

The container:
- Installs dependencies
- Verifies the real Ruflo runtime
- Builds the frontend
- Starts the API server (serves frontend + API)
- Handles SIGTERM/SIGINT
- Exposes health checks

**Never put secrets in the Docker image.** Use Hugging Face Secrets.

---

## Health Check

```bash
curl -fsS http://127.0.0.1:${PORT}/health
```

Response reflects **actual** status:
```json
{
  "status": "ok",
  "service": "davteam-ruflos-ai-agents",
  "ruflo": true,
  "rufloVersion": "3.45.0",
  "osiri": true
}
```

---

## Testing

```bash
npm test
```

The test suite verifies:
- Ruflo runtime availability and version (3.45.0)
- Doctor / MetaHarness (graceful degradation reported honestly)
- Capability detection
- Agent spawn (real)
- Task creation (real)
- Workspace security (path traversal blocked, system paths blocked)
- Provider/model listing (no keys leaked)
- Memory operations

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `ruflo` command not found | Run `npm install` — the ruflo binary is in `node_modules/ruflo/bin/ruflo.js` |
| `npm install` OOMs | Use `npm install --omit=optional --ignore-scripts` |
| Model not working | Set `MODEL_API_KEY` (and `MODEL_BASE_URL`, `MODEL_NAME`) server-side |
| MetaHarness shows "Not installed" | This is expected — MetaHarness is optional and degrades gracefully. Install MetaHarness packages if you need full functionality. |
| Port not reachable | Ensure `HOST=0.0.0.0` and `PORT=7860` for Hugging Face |
| `path-to-regexp` error | Express 5 requires named wildcards (`{*path}`) not bare `*` |

---

## Security

- **Workspace isolation:** Agents/tools operate only within the configured `WORKSPACE` directory
- **Path validation:** Path traversal and system paths (`/etc`, `/root`, `/proc`, `/sys`, `/dev`) are blocked
- **Command validation:** Dangerous commands (rm -rf /, mkfs, fork bombs, shutdown) are blocked
- **Secret redaction:** API keys are redacted from all logs
- **Keyless frontend:** No provider credentials ever reach the browser
- **Resource limits:** Command timeouts, output truncation, process termination
- **Audit logging:** All filesystem and command actions are logged

---

## License

MIT — see `LICENSE`.

The upstream Ruflo project (Copyright (c) 2024-2026 ruvnet) is MIT licensed and preserved verbatim. DavTeam additions are MIT licensed. See `ATTRIBUTION.md` for details.

## Upstream Project Reference

- Repository: https://github.com/ruvnet/ruflo
- npm: https://www.npmjs.com/package/ruflo
- Version: 3.45.0
