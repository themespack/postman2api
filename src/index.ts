import { Hono } from "hono";
import { type Env, config, initConfig } from "./config";
import { chatRouter } from "./api/chat";
import { modelsRouter } from "./api/models";
import { accountsRouter } from "./api/accounts";
import { statsRouter } from "./api/stats";
import { settingsRouter } from "./api/settings";
import { initWs } from "./ws/index";
import { warmupAllAccounts } from "./auth/warmup";
import { db, initDb } from "./db/index";
import { settings } from "./db/schema";
import { eq } from "drizzle-orm";
import { isDefaultEncryptionKey } from "./utils/crypto";

export { WSHub } from "./ws/hub";

const ISOLATE_STARTED_AT = Date.now();

const app = new Hono<{ Bindings: Env }>();

// Wire per-request bindings (D1, WS hub, secrets) into the module-level
// accessors used throughout the codebase.
app.use("*", async (c, next) => {
  initDb(c.env.DB);
  initConfig(c.env);
  initWs(c.env);
  await next();
});

app.get("/health", (c) => c.json({ status: "ok", uptimeMs: Date.now() - ISOLATE_STARTED_AT }));

// WebSocket upgrade for the live dashboard — proxied to the WSHub Durable Object.
app.get("/ws", (c) => {
  const id = c.env.WS_HUB.idFromName("global");
  const stub = c.env.WS_HUB.get(id);
  return stub.fetch(c.req.raw);
});

// API key auth middleware for /v1/* routes (API consumers).
// Accepts both the OpenAI convention (`Authorization: Bearer <key>`, used by
// /v1/chat/completions) and the Anthropic convention (`x-api-key: <key>`,
// used by /v1/messages) on every /v1/* route, since router/aggregator apps
// (OpenRouter-style) send whichever header matches the provider type they
// think they're talking to.
app.use("/v1/*", async (c, next) => {
  const bearer = c.req.header("Authorization") || "";
  const xApiKey = c.req.header("x-api-key") || "";
  const apiKey = await getApiKey();
  if (bearer !== `Bearer ${apiKey}` && xApiKey !== apiKey) {
    return c.json({ error: { message: "Invalid API key", type: "invalid_api_key" } }, 401);
  }
  await next();
});

// Routes
app.route("/", chatRouter);
app.route("/", modelsRouter);
app.route("/api/accounts", accountsRouter);
app.route("/api/stats", statsRouter);
app.route("/api/settings", settingsRouter);

// Everything else (dashboard SPA) is served from the ASSETS binding.
app.get("*", (c) => c.env.ASSETS.fetch(c.req.raw));

async function getApiKey(): Promise<string> {
  const [row] = await db.select().from(settings).where(eq(settings.key, "api_key")).limit(1);
  return row?.value || config.apiKey;
}

export default {
  fetch: app.fetch,

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    initDb(env.DB);
    initConfig(env);
    if (isDefaultEncryptionKey()) {
      console.warn("[postman2api] WARNING: Using default encryption key. Set the ENCRYPTION_KEY secret!");
    }
    ctx.waitUntil(warmupAllAccounts());
  },
};
