type WSMessage = Record<string, unknown>;

interface WSEnv {
  WS_HUB: DurableObjectNamespace;
}

let currentEnv: WSEnv | null = null;

export function initWs(env: WSEnv): void {
  currentEnv = env;
}

/**
 * Fire-and-forget push to the WSHub Durable Object, which fans the message
 * out to every connected dashboard WebSocket. Best-effort: a dropped
 * broadcast never fails the caller's request.
 */
export function broadcast(message: WSMessage): void {
  if (!currentEnv) return;
  const id = currentEnv.WS_HUB.idFromName("global");
  const stub = currentEnv.WS_HUB.get(id);
  stub
    .fetch("https://ws-hub/broadcast", {
      method: "POST",
      body: JSON.stringify(message),
    })
    .catch(() => {});
}
