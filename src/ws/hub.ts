/**
 * WSHub fans dashboard-facing events (account status, request completion,
 * login progress) out to every connected browser tab. Uses the Hibernatable
 * WebSockets API so the Durable Object can spin down between events instead
 * of billing for idle wall-clock time.
 */
export class WSHub {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: unknown,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/broadcast") {
      const message = await request.text();
      for (const ws of this.state.getWebSockets()) {
        try {
          ws.send(message);
        } catch {
          // Socket is gone; hibernation cleanup will drop it.
        }
      }
      return new Response("ok");
    }

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.state.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  // Server-push only — client messages are ignored.
  async webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer): Promise<void> {}

  async webSocketClose(ws: WebSocket, code: number, reason: string, _wasClean: boolean): Promise<void> {
    ws.close(code, reason);
  }

  async webSocketError(_ws: WebSocket, _error: unknown): Promise<void> {}
}
