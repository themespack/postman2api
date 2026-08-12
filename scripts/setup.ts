#!/usr/bin/env bun
/**
 * One-shot bootstrap + deploy for postman2api on Cloudflare Workers.
 *
 * Idempotent: safe to re-run. On each run it:
 *   1. Makes sure you're logged in to Cloudflare (launches `wrangler login` if not)
 *   2. Creates the D1 database if missing, and patches wrangler.json with its id
 *   3. Applies D1 migrations against the remote database
 *   4. Generates + uploads API_KEY / ENCRYPTION_KEY secrets if not already set
 *   5. Builds the dashboard (Vite → dashboard/dist, served via Workers Assets)
 *   6. Deploys the Worker
 *
 * Durable Object bindings/migrations and Cron Triggers need no setup step —
 * `wrangler deploy` provisions those directly from wrangler.json.
 */

import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const CONFIG_PATH = resolve(ROOT, "wrangler.json");
const PLACEHOLDER_DB_ID = "REPLACE_WITH_YOUR_D1_DATABASE_ID";
const DB_NAME = "postman2api";
const REQUIRED_SECRETS = ["API_KEY", "ENCRYPTION_KEY"] as const;

const color = (code: string, text: string) => `\x1b[${code}m${text}\x1b[0m`;
const step = (msg: string) => console.log(color("36;1", `\n▶ ${msg}`));
const ok = (msg: string) => console.log(color("32", `  ✔ ${msg}`));
const info = (msg: string) => console.log(`  ${msg}`);
const warn = (msg: string) => console.log(color("33", `  ⚠ ${msg}`));

async function run(
  cmd: string[],
  opts: { capture?: boolean; allowFailure?: boolean; input?: string; cwd?: string } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn({
    cmd,
    cwd: opts.cwd ?? ROOT,
    stdin: opts.input !== undefined ? "pipe" : "ignore",
    stdout: opts.capture ? "pipe" : "inherit",
    stderr: opts.capture ? "pipe" : "inherit",
  });
  if (opts.input !== undefined && proc.stdin) {
    proc.stdin.write(opts.input);
    await proc.stdin.end();
  }
  const [stdout, stderr] = await Promise.all([
    opts.capture ? new Response(proc.stdout).text() : Promise.resolve(""),
    opts.capture ? new Response(proc.stderr).text() : Promise.resolve(""),
  ]);
  const code = await proc.exited;
  if (code !== 0 && !opts.allowFailure) {
    throw new Error(`Command failed (${code}): ${cmd.join(" ")}\n${stderr}`);
  }
  return { code, stdout, stderr };
}

function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function readConfig(): Promise<any> {
  return JSON.parse(await Bun.file(CONFIG_PATH).text());
}

async function writeConfig(cfg: any): Promise<void> {
  await Bun.write(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n");
}

async function ensureLoggedIn(): Promise<void> {
  step("Checking Cloudflare authentication");
  const whoami = await run(["bunx", "wrangler", "whoami"], { capture: true, allowFailure: true });
  if (whoami.stdout.includes("You are not authenticated")) {
    warn("Not logged in — launching `wrangler login` (opens your browser)");
    await run(["bunx", "wrangler", "login"]);
  } else {
    ok("Already authenticated");
  }
}

async function ensureD1Database(): Promise<void> {
  step("Checking D1 database");
  let cfg = await readConfig();
  const currentId = cfg.d1_databases?.[0]?.database_id;

  if (currentId && currentId !== PLACEHOLDER_DB_ID) {
    ok(`wrangler.json already has a database id (${currentId.slice(0, 8)}…)`);
    return;
  }

  info(`Creating D1 database "${DB_NAME}"…`);
  const create = await run(
    ["bunx", "wrangler", "d1", "create", DB_NAME, "--binding", "DB", "--update-config"],
    { capture: true, allowFailure: true },
  );

  if (create.code === 0) {
    ok("Database created and wrangler.json updated automatically");
    return;
  }

  if (!/already exists/i.test(create.stderr + create.stdout)) {
    console.error(create.stdout);
    console.error(create.stderr);
    throw new Error("wrangler d1 create failed");
  }

  warn(`Database "${DB_NAME}" already exists on this account — looking up its id`);
  const list = await run(["bunx", "wrangler", "d1", "list", "--json"], { capture: true });
  const databases = JSON.parse(list.stdout);
  const existing = databases.find((d: any) => d.name === DB_NAME);
  if (!existing) throw new Error(`Could not find existing D1 database named "${DB_NAME}" via \`wrangler d1 list\``);

  cfg = await readConfig();
  cfg.d1_databases[0].database_id = existing.uuid;
  await writeConfig(cfg);
  ok(`wrangler.json patched with existing database id (${String(existing.uuid).slice(0, 8)}…)`);
}

async function applyMigrations(): Promise<void> {
  step("Applying D1 migrations (remote)");
  await run(["bunx", "wrangler", "d1", "migrations", "apply", "DB", "--remote"]);
  ok("Migrations applied");
}

async function ensureSecrets(): Promise<void> {
  step("Checking secrets");
  const list = await run(["bunx", "wrangler", "secret", "list", "--format", "json"], {
    capture: true,
    allowFailure: true,
  });
  let existing: string[] = [];
  try {
    existing = JSON.parse(list.stdout).map((s: any) => s.name);
  } catch {
    // Worker doesn't exist yet on first-ever deploy — treat as "no secrets set".
  }

  const generated: Record<string, string> = {};
  for (const name of REQUIRED_SECRETS) {
    if (existing.includes(name)) {
      ok(`${name} already set`);
      continue;
    }
    const value = randomHex(16);
    generated[name] = value;
    info(`Generating ${name} and uploading…`);
    await run(["bunx", "wrangler", "secret", "put", name], { input: value });
    ok(`${name} set`);
  }

  if (Object.keys(generated).length > 0) {
    console.log(color("33;1", "\n  Save these — they are not retrievable again:"));
    for (const [name, value] of Object.entries(generated)) {
      console.log(`    ${color("1", name)}=${value}`);
    }
  }
}

async function buildDashboard(): Promise<void> {
  step("Building dashboard");
  const dashboardDir = resolve(ROOT, "dashboard");
  await run(["bun", "install"], { cwd: dashboardDir });
  await run(["bun", "run", "build"], { cwd: dashboardDir });
  ok("Dashboard built");
}

async function deploy(): Promise<void> {
  step("Deploying Worker");
  await run(["bunx", "wrangler", "deploy"]);
  ok("Deployed");
}

async function main() {
  await ensureLoggedIn();
  await ensureD1Database();
  await applyMigrations();
  await ensureSecrets();
  await buildDashboard();
  await deploy();
  console.log(color("32;1", "\n✔ Setup + deploy complete.\n"));
  console.log("  Add your first Postman account with:");
  console.log(color("36", "    bun src/cli.ts login <email> <password>\n"));
}

main().catch((err) => {
  console.error(color("31;1", `\n✘ ${err instanceof Error ? err.message : String(err)}`));
  process.exit(1);
});
