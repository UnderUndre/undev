import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api.js";
import { useChannel } from "./useWebSocket.js";

export interface ServiceStatus {
  name: string;
  running: boolean;
}

export interface DockerContainer {
  name: string;
  status: string;
  cpuPercent: number;
  memoryMb: number;
}

export interface HealthData {
  cpu: number;
  memory: number;
  disk: number;
  swap: number;
  services: ServiceStatus[];
  containers: DockerContainer[];
  checkedAt: string;
}

export function useHealth(serverId: string) {
  const queryClient = useQueryClient();

  const { data: health, isLoading } = useQuery({
    queryKey: ["server", serverId, "health"],
    queryFn: () => api.get<HealthData>(`/servers/${serverId}/health`),
    enabled: Boolean(serverId),
  });

  const { lastMessage } = useChannel(`health:${serverId}`);

  useEffect(() => {
    if (!lastMessage) return;
    if (lastMessage.type === "update") {
      queryClient.setQueryData(
        ["server", serverId, "health"],
        lastMessage.data as HealthData,
      );
    }
  }, [lastMessage, queryClient, serverId]);

  const refresh = async () => {
    await api.post(`/servers/${serverId}/health/refresh`);
    await queryClient.invalidateQueries({
      queryKey: ["server", serverId, "health"],
    });
  };

  return { health, isLoading, refresh };
}
