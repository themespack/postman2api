#!/usr/bin/env bun
/**
 * postman2api CLI — operates against the local D1 database emulated by
 * Wrangler (the same one `wrangler dev` uses), via getPlatformProxy().
 *
 * Usage:
 *   bun src/cli.ts login <email> <password>          Login Postman account via browser (Camoufox)
 *   bun src/cli.ts login-remote <email> <password>   Login locally, then push the tokens to a deployed Worker
 *   bun src/cli.ts accounts                          List accounts
 *   bun src/cli.ts quota                             Check account quotas
 *   bun src/cli.ts status                            Show config overview
 *   bun src/cli.ts set-admin-key <key>               Set admin password
 *
 * To run the server itself, use `wrangler dev` / `wrangler deploy`.
 * To apply the D1 schema, use `wrangler d1 migrations apply DB --local|--remote`.
 *
 * login-remote needs the deployed Worker's URL and API_KEY, since the login
 * itself always runs against the local D1 (browser automation can't run in
 * Workers). Set them via env vars or flags:
 *   POSTMAN2API_REMOTE_URL=https://postman2api.example.workers.dev \
 *   POSTMAN2API_API_KEY=... \
 *   bun src/cli.ts login-remote you@example.com yourpassword
 * or: bun src/cli.ts login-remote you@example.com yourpassword --url=https://... --api-key=...
 */

import { createRequire } from "node:module";
import { dirname, resolve as resolvePath } from "node:path";
import { accounts, settings } from "./db/schema";
import { eq } from "drizzle-orm";
import { initDb, db } from "./db/index";
import { initConfig, config, type Env } from "./config";
import { initWs } from "./ws/index";
import { loginPostmanAccount } from "./auth/bridge";
import { warmupAccount } from "./auth/warmup";

// Bun resolves the bare specifier "wrangler" to the project's own
// wrangler.json (same basename, JSON extension) instead of the npm
// package in node_modules — `import { getPlatformProxy } from "wrangler"`
// then fails with "Export named 'getPlatformProxy' not found in module
// '.../wrangler.json'". Resolving through the package's own package.json
// (a different specifier, so the shortcut doesn't kick in) sidesteps it.
async function loadWrangler(): Promise<typeof import("wrangler")> {
  const require = createRequire(import.meta.url);
  const pkgPath = require.resolve("wrangler/package.json");
  const pkg = require(pkgPath) as { main: string; exports?: { ["."]?: { default?: string } } };
  const entry = resolvePath(dirname(pkgPath), pkg.exports?.["."]?.default ?? pkg.main);
  return import(entry);
}

const C: Record<string, string> = {
  reset: "\x1b[0m", green: "\x1b[32m", yellow: "\x1b[33m",
  blue: "\x1b[34m", red: "\x1b[31m", cyan: "\x1b[36m", bold: "\x1b[1m",
};

function c(text: string, color: string): string {
  return `${C[color]}${text}${C.reset}`;
}

function usage(): void {
  console.log(`postman2api CLI

Usage:
  bun src/cli.ts login <email> <password>          Login Postman via browser (Camoufox)
  bun src/cli.ts login-remote <email> <password>   Login locally, push tokens to a deployed Worker
  bun src/cli.ts accounts                          List accounts
  bun src/cli.ts quota                             Check account quotas
  bun src/cli.ts status                            Show config overview
  bun src/cli.ts set-admin-key <key>               Set admin password

Run the server with: wrangler dev / wrangler deploy
Apply the schema with: wrangler d1 migrations apply DB --local|--remote

login-remote needs the deployed Worker's URL + API_KEY, via env vars
(POSTMAN2API_REMOTE_URL, POSTMAN2API_API_KEY) or --url=/--api-key= flags.
`);
}

async function cmdLogin(args: string[]): Promise<void> {
  if (args.length < 2) {
    console.log(c("Usage: bun src/cli.ts login <email> <password>", "red"));
    return;
  }
  const [email, password] = args;
  const headless = args.includes("--headless");
  console.log(c(`Logging in ${email} via Camoufox (headless=${headless})...`, "cyan"));
  const result = await loginPostmanAccount(email!, password!, headless, (log) => {
    console.log(c(`  [${log.step}]`, "blue") + ` ${log.msg}`);
  });
  if (result.success) {
    console.log(c(`✔ Account ${email} added (id=${result.accountId})`, "green"));
  } else {
    console.log(c(`✘ Login failed: ${result.error}`, "red"));
  }
}

async function cmdLoginRemote(args: string[]): Promise<void> {
  const positional = args.filter((a) => !a.startsWith("--"));
  if (positional.length < 2) {
    console.log(c("Usage: bun src/cli.ts login-remote <email> <password> [--url=...] [--api-key=...]", "red"));
    return;
  }
  const [email, password] = positional;
  const headless = args.includes("--headless");
  const remoteUrl = (args.find((a) => a.startsWith("--url=")) || "").slice(6) || process.env.POSTMAN2API_REMOTE_URL;
  const apiKey = (args.find((a) => a.startsWith("--api-key=")) || "").slice(10) || process.env.POSTMAN2API_API_KEY;

  if (!remoteUrl || !apiKey) {
    console.log(c("Missing remote URL and/or API key.", "red"));
    console.log("Set POSTMAN2API_REMOTE_URL / POSTMAN2API_API_KEY env vars, or pass --url=/--api-key=.");
    return;
  }

  console.log(c(`Logging in ${email} via Camoufox (headless=${headless})...`, "cyan"));
  const result = await loginPostmanAccount(email!, password!, headless, (log) => {
    console.log(c(`  [${log.step}]`, "blue") + ` ${log.msg}`);
  });
  if (!result.success) {
    console.log(c(`✘ Login failed: ${result.error}`, "red"));
    return;
  }
  console.log(c(`✔ Local login OK (id=${result.accountId})`, "green"));

  const [account] = await db.select().from(accounts).where(eq(accounts.email, email!)).limit(1);
  const tokens = typeof account!.tokens === "string" ? JSON.parse(account!.tokens) : account!.tokens;

  console.log(c(`Pushing tokens to ${remoteUrl}...`, "cyan"));
  const res = await fetch(`${remoteUrl.replace(/\/$/, "")}/api/accounts`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify({ email, tokens }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.log(c(`✘ Remote sync failed (${res.status}): ${JSON.stringify(body)}`, "red"));
    return;
  }
  console.log(c(`✔ Account ${email} synced to remote (id=${(body as any).account?.id})`, "green"));
}

async function cmdAccounts(): Promise<void> {
  const allAccounts = await db.select().from(accounts);
  if (allAccounts.length === 0) {
    console.log(c("No accounts", "yellow"));
    return;
  }
  console.log(c(`\n--- Accounts (${allAccounts.length}) ---`, "cyan"));
  for (const a of allAccounts) {
    console.log(`  ${a.id}  ${a.email}  ${c(a.status, a.status === "active" ? "green" : "red")}  ${a.enabled ? "" : c("disabled", "yellow")}`);
  }
}

async function cmdQuota(): Promise<void> {
  const allAccounts = await db.select().from(accounts);
  if (allAccounts.length === 0) {
    console.log(c("No accounts", "yellow"));
    return;
  }
  for (const a of allAccounts) {
    const result = await warmupAccount(a.id);
    console.log(c(`\n${a.email} (${a.status})`, "bold"));
    if (!result.success) {
      console.log(`  Error: ${result.error}`);
    } else {
      console.log(`  ${c("Healthy", "green")}`);
    }
  }
}

async function cmdStatus(): Promise<void> {
  console.log(c("\n--- postman2api Status ---", "cyan"));
  console.log(`API Key       : ${config.apiKey}`);

  const allAccounts = await db.select().from(accounts);
  const active = allAccounts.filter((a) => a.status === "active" && a.enabled);
  console.log(`Accounts      : ${allAccounts.length} total, ${c(String(active.length), "green")} active`);
}

async function cmdSetAdminKey(args: string[]): Promise<void> {
  if (!args[0]) {
    console.log(c("Usage: bun src/cli.ts set-admin-key <key>", "red"));
    return;
  }
  await db.update(settings).set({ value: args[0], updatedAt: new Date() }).where(eq(settings.key, "admin_key"));
  console.log(c("✔ Admin password updated", "green"));
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    usage();
    return;
  }
  const [cmd, ...rest] = argv;

  const { getPlatformProxy } = await loadWrangler();
  const proxy = await getPlatformProxy<Env>();
  initDb(proxy.env.DB);
  initConfig(proxy.env);
  initWs(proxy.env);

  try {
    switch (cmd) {
      case "login": await cmdLogin(rest); break;
      case "login-remote": await cmdLoginRemote(rest); break;
      case "accounts": await cmdAccounts(); break;
      case "quota": await cmdQuota(); break;
      case "status": await cmdStatus(); break;
      case "set-admin-key": await cmdSetAdminKey(rest); break;
      case "help":
      case "-h":
      case "--help": usage(); break;
      default: console.log(c(`Unknown command: ${cmd}`, "red")); usage();
    }
  } finally {
    await proxy.dispose();
  }
}

main().catch((err) => {
  console.error(c(`Error: ${err}`, "red"));
  process.exit(1);
});
