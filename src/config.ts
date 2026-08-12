export interface Env {
  DB: D1Database;
  WS_HUB: DurableObjectNamespace;
  ASSETS: Fetcher;
  API_KEY?: string;
  ENCRYPTION_KEY?: string;
  PROVIDER_REQUEST_TIMEOUT_MS?: string;
}

const DEFAULT_ENCRYPTION_KEY = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6";

let currentEnv: Env | null = null;

export function initConfig(env: Env): void {
  currentEnv = env;
}

export const config = {
  get apiKey(): string {
    return currentEnv?.API_KEY || "postman2api-secret-key";
  },
  get encryptionKey(): string {
    return currentEnv?.ENCRYPTION_KEY || DEFAULT_ENCRYPTION_KEY;
  },
  get providerRequestTimeoutMs(): number {
    return Number(currentEnv?.PROVIDER_REQUEST_TIMEOUT_MS) || 120_000;
  },
};

export const DEFAULT_ENCRYPTION_KEY_VALUE = DEFAULT_ENCRYPTION_KEY;
