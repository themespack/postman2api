> ⚠️ **EDUCATIONAL PURPOSE ONLY** — This project is provided **as-is** for research and educational purposes. The author is **not responsible** for any misuse, ToS violations, or consequences resulting from the use of this software. Use at your own risk.

# postman2api

Postman AI proxy on **Cloudflare Workers** — converts Postman's agent chat API into an OpenAI + Anthropic-compatible endpoint with multi-account pooling, round-robin load balancing, and a live dashboard.

## Architecture

```
Client → Worker (Hono) → Account Pool (round-robin) → Postman Provider → Postman API
              ↕                    ↕
       Dashboard (Assets)    D1 (accounts, logs, settings)
              ↕
       WSHub (Durable Object) — live dashboard push
```

Hono + TypeScript on Workers. Drizzle ORM over **D1**. A Durable Object (`WSHub`) fans out live account/request events to the dashboard over WebSocket. A Cron Trigger runs account health/quota warmup every 15 minutes.

> Browser-automated Postman login (Google OAuth via Python + Camoufox) cannot run inside the Workers runtime — no subprocess execution, no Python. That flow stays a **local-only CLI tool** (`bun src/cli.ts login`); accounts are added to the deployed Worker via manual token paste (dashboard or `POST /api/accounts`).

## Deploy

```bash
bun install
cd dashboard && bun install && bun run build && cd ..

# Create the D1 database, then paste its id into wrangler.toml
bunx wrangler d1 create postman2api

# Apply the schema
bunx wrangler d1 migrations apply DB --remote

# Secrets (never committed)
bunx wrangler secret put API_KEY
bunx wrangler secret put ENCRYPTION_KEY

bunx wrangler deploy
```

## Local development

```bash
cp .dev.vars.example .dev.vars   # local-only secrets, gitignored
bunx wrangler d1 migrations apply DB --local
bun run build                     # build the dashboard once
bun run dev                       # wrangler dev, http://localhost:8787
```

- **Dashboard**: http://localhost:8787
- **OpenAI**: http://localhost:8787/v1/chat/completions
- **Anthropic**: http://localhost:8787/v1/messages

## Adding accounts

Since browser login can't run on Workers, generate tokens locally and paste them in:

```bash
python3 -m venv scripts/auth/.venv
source scripts/auth/.venv/bin/activate
pip install -r scripts/auth/requirements.txt

bun src/cli.ts login you@gmail.com yourpassword
```

This writes directly into the local D1 database (via Wrangler's `getPlatformProxy`, the same store `wrangler dev` uses). To push accounts to a deployed Worker, use the dashboard's "Manual Token" form or `POST /api/accounts` with the `postman_sid` / `user_id` / `workspace_id` / `workspace_subdomain` tokens the CLI prints — or run `wrangler dev --remote` so the CLI writes straight to the production D1 database.

## API Usage

```bash
# OpenAI
curl https://<your-worker>.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-4-5","messages":[{"role":"user","content":"Hello!"}],"stream":true}'

# Anthropic
curl https://<your-worker>.workers.dev/v1/messages \
  -H "x-api-key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-4-20250514","max_tokens":1024,"messages":[{"role":"user","content":"Hello"}]}'
```

## Models

`claude-opus-4-8`, `claude-opus-4-7`, `claude-opus-4-6`, `claude-opus-4-5`, `claude-sonnet-4-6`, `claude-sonnet-4-5`, `claude-haiku-4-5`, `gpt-5.5`, `gpt-5.4`, `gpt-5.2`, `auto`

Anthropic `/v1/messages` accepts official Claude model IDs and normalizes them automatically.

## Features

- OpenAI `/v1/chat/completions` + Anthropic `/v1/messages` protocol
- SSE streaming with thinking/reasoning tokens
- Multi-account pool with round-robin, backed by D1
- Auto-switch on quota exhaustion
- Real-time dashboard via a WebSocket Durable Object
- Cron-triggered quota/health warmup (every 15 min)
- D1-backed request logging

## CLI

`bun src/cli.ts` operates against the local D1 database Wrangler emulates (the same one `wrangler dev` uses):

```bash
bun src/cli.ts login <email> <password>   # browser login (local only, needs Python + Camoufox)
bun src/cli.ts accounts                    # list accounts
bun src/cli.ts quota                       # check account quotas
bun src/cli.ts status                      # config overview
bun src/cli.ts set-admin-key <key>         # set admin password
```

---

> ⚠️ **EDUCATIONAL PURPOSE ONLY** — This project is provided **as-is** for research and educational purposes. The author is **not responsible** for any misuse, ToS violations, or consequences resulting from the use of this software. Use at your own risk.
