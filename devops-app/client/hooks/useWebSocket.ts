import { useEffect, useRef, useCallback, useState } from "react";
import { wsClient, type WsMessage } from "../lib/ws.js";

export function useWebSocket() {
  const connectedRef = useRef(false);

  useEffect(() => {
    if (!connectedRef.current) {
      wsClient.connect();
      connectedRef.current = true;
    }
    return () => {
      // Don't disconnect on unmount — keep connection alive across routes
    };
  }, []);

  const subscribe = useCallback(
    (channel: string, handler: (msg: WsMessage) => void) => {
      return wsClient.subscribe(channel, handler);
    },
    [],
  );

  return { subscribe };
}

export function useChannel(channel: string | null) {
  const [messages, setMessages] = useState<WsMessage[]>([]);
  const [lastMessage, setLastMessage] = useState<WsMessage | null>(null);

  useEffect(() => {
    if (!channel) return;

    const unsub = wsClient.subscribe(channel, (msg) => {
      setMessages((prev) => [...prev, msg]);
      setLastMessage(msg);
    });

    return unsub;
  }, [channel]);

  return { messages, lastMessage };
}
