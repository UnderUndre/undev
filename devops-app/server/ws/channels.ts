import type { WebSocket } from "ws";

type ChannelCallback = (data: unknown) => void;

class ChannelManager {
  // channel → Set of WebSocket clients
  private channels = new Map<string, Set<WebSocket>>();
  // ws → Set of channel names (for cleanup on disconnect)
  private clientChannels = new Map<WebSocket, Set<string>>();

  subscribe(ws: WebSocket, channel: string): void {
    if (!this.channels.has(channel)) {
      this.channels.set(channel, new Set());
    }
    this.channels.get(channel)!.add(ws);

    if (!this.clientChannels.has(ws)) {
      this.clientChannels.set(ws, new Set());
    }
    this.clientChannels.get(ws)!.add(channel);
  }

  unsubscribe(ws: WebSocket, channel: string): void {
    this.channels.get(channel)?.delete(ws);
    this.clientChannels.get(ws)?.delete(channel);

    // Cleanup empty channels
    if (this.channels.get(channel)?.size === 0) {
      this.channels.delete(channel);
    }
  }

  unsubscribeAll(ws: WebSocket): void {
    const channels = this.clientChannels.get(ws);
    if (channels) {
      for (const ch of channels) {
        this.channels.get(ch)?.delete(ws);
        if (this.channels.get(ch)?.size === 0) {
          this.channels.delete(ch);
        }
      }
    }
    this.clientChannels.delete(ws);
  }

  broadcast(channel: string, message: Record<string, unknown>): void {
    const clients = this.channels.get(channel);
    if (!clients) return;

    const payload = JSON.stringify({
      channel,
      ...message,
      timestamp: new Date().toISOString(),
    });

    for (const ws of clients) {
      if (ws.readyState === ws.OPEN) {
        ws.send(payload);
      }
    }
  }

  getSubscribers(channel: string): Set<WebSocket> {
    return this.channels.get(channel) ?? new Set();
  }

  getClientChannels(ws: WebSocket): Set<string> {
    return this.clientChannels.get(ws) ?? new Set();
  }
}

export const channelManager = new ChannelManager();
