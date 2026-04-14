type MessageHandler = (msg: WsMessage) => void;

export interface WsMessage {
  channel: string;
  type: string;
  data: unknown;
  timestamp: string;
}

const MAX_RETRY_DELAY = 30_000;
const BASE_RETRY_DELAY = 1_000;

export class WsClient {
  private ws: WebSocket | null = null;
  private retryCount = 0;
  private handlers = new Map<string, Set<MessageHandler>>();
  private pendingSubscriptions = new Set<string>();
  private connected = false;
  private intentionallyClosed = false;

  connect(): void {
    this.intentionallyClosed = false;
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${protocol}//${location.host}/ws`;

    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      this.connected = true;
      this.retryCount = 0;
      // Re-subscribe to all channels
      for (const ch of this.pendingSubscriptions) {
        this.send({ action: "subscribe", channel: ch });
      }
    };

    this.ws.onmessage = (event) => {
      try {
        const msg: WsMessage = JSON.parse(event.data);
        const channelHandlers = this.handlers.get(msg.channel);
        if (channelHandlers) {
          for (const handler of channelHandlers) {
            handler(msg);
          }
        }
        // Also notify global handlers
        const globalHandlers = this.handlers.get("*");
        if (globalHandlers) {
          for (const handler of globalHandlers) {
            handler(msg);
          }
        }
      } catch {
        // Ignore parse errors
      }
    };

    this.ws.onclose = () => {
      this.connected = false;
      if (!this.intentionallyClosed) {
        this.reconnect();
      }
    };

    this.ws.onerror = () => {
      // onclose will fire after onerror
    };
  }

  private reconnect(): void {
    const delay = Math.min(
      BASE_RETRY_DELAY * 2 ** this.retryCount,
      MAX_RETRY_DELAY,
    );
    this.retryCount++;
    setTimeout(() => this.connect(), delay);
  }

  subscribe(channel: string, handler: MessageHandler): () => void {
    if (!this.handlers.has(channel)) {
      this.handlers.set(channel, new Set());
    }
    this.handlers.get(channel)!.add(handler);
    this.pendingSubscriptions.add(channel);

    if (this.connected) {
      this.send({ action: "subscribe", channel });
    }

    return () => {
      this.handlers.get(channel)?.delete(handler);
      if (this.handlers.get(channel)?.size === 0) {
        this.handlers.delete(channel);
        this.pendingSubscriptions.delete(channel);
        if (this.connected) {
          this.send({ action: "unsubscribe", channel });
        }
      }
    };
  }

  private send(msg: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  disconnect(): void {
    this.intentionallyClosed = true;
    this.ws?.close();
  }
}

// Singleton
export const wsClient = new WsClient();
