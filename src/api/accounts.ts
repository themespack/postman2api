import { Hono } from "hono";
import { db } from "../db/index";
import { accounts, requestLogs } from "../db/schema";
import { eq } from "drizzle-orm";
import { encrypt } from "../utils/crypto";
import { warmupAccount } from "../auth/warmup";
import { pool } from "../proxy/pool";
import { broadcast } from "../ws/index";

export const accountsRouter = new Hono();

// List all accounts
accountsRouter.get("/", async (c) => {
  const allAccounts = await db.select().from(accounts);
  const sanitized = allAccounts.map((acc) => {
    let tokens: any = acc.tokens;
    if (typeof tokens === "string") {
      try { tokens = JSON.parse(tokens); } catch { tokens = {}; }
    }
    return {
      id: acc.id,
      email: acc.email,
      status: acc.status,
      enabled: acc.enabled,
      quotaLimit: acc.quotaLimit,
      quotaRemaining: acc.quotaRemaining,
      lastUsedAt: acc.lastUsedAt,
      lastLoginAt: acc.lastLoginAt,
      errorMessage: acc.errorMessage,
      hasTokens: !!(tokens?.postman_sid),
      workspaceSubdomain: tokens?.workspace_subdomain || null,
      createdAt: acc.createdAt,
      updatedAt: acc.updatedAt,
    };
  });
  return c.json({ data: sanitized });
});

// Add account via manual token paste. This is the only way to add accounts
// on Workers: browser-automated Google OAuth login requires a Python +
// Camoufox process, which can't run in the Workers runtime. Run
// `bun src/cli.ts login <email> <password>` locally to obtain tokens, then
// paste them in here (or via the dashboard's "Manual" add-account form).
accountsRouter.post("/", async (c) => {
  const body = await c.req.json().catch(() => ({})) as {
    email?: string;
    tokens?: { postman_sid: string; user_id: string; workspace_id: string; workspace_subdomain: string };
  };

  if (!body.email || !body.tokens?.postman_sid) {
    return c.json({ error: "Email and tokens (postman_sid, user_id, workspace_id, workspace_subdomain) required" }, 400);
  }

  const [existing] = await db.select().from(accounts).where(eq(accounts.email, body.email)).limit(1);

  if (existing) {
    const [updated] = await db.update(accounts)
      .set({
          tokens: JSON.stringify(body.tokens),
        status: "active",
        lastLoginAt: new Date(),
        updatedAt: new Date(),
        errorMessage: null,
      })
      .where(eq(accounts.id, existing.id))
      .returning();
    broadcast({ type: "account_updated", data: { id: updated!.id, status: "active" } });
    return c.json({ success: true, account: { id: updated!.id, email: updated!.email } });
  }

  const [created] = await db.insert(accounts).values({
    email: body.email,
    password: await encrypt("manual"),
    tokens: JSON.stringify(body.tokens),
    status: "active",
    lastLoginAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  }).returning();

  broadcast({ type: "account_added", data: { id: created!.id, email: created!.email, status: "active" } });
  return c.json({ success: true, account: { id: created!.id, email: created!.email } });
});

// Delete account
accountsRouter.delete("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  // Nullify FK references in request_logs before deleting
  await db.update(requestLogs).set({ accountId: null }).where(eq(requestLogs.accountId, id));
  await db.delete(accounts).where(eq(accounts.id, id));
  pool.invalidate();
  broadcast({ type: "account_deleted", data: { id } });
  return c.json({ success: true });
});

// Warmup / health check single account
accountsRouter.post("/:id/warmup", async (c) => {
  const id = Number(c.req.param("id"));
  const result = await warmupAccount(id);
  return c.json(result, result.success ? 200 : 400);
});

// Toggle enabled
accountsRouter.patch("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json().catch(() => ({})) as { enabled?: boolean };
  if (body.enabled === undefined) {
    return c.json({ error: "Missing 'enabled' field" }, 400);
  }
  const account = await pool.setEnabled(id, body.enabled);
  return c.json({ success: true, account: { id: account?.id, enabled: account?.enabled } });
});
