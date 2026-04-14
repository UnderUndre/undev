import React, { useState } from "react";
import { useHealth, type ServiceStatus, type DockerContainer } from "../../hooks/useHealth.js";

interface HealthPanelProps {
  serverId: string;
}

const THRESHOLD_GREEN = 60;
const THRESHOLD_YELLOW = 80;

function getThresholdColor(value: number): string {
  if (value < THRESHOLD_GREEN) return "text-green-400";
  if (value < THRESHOLD_YELLOW) return "text-yellow-400";
  return "text-red-400";
}

function getBarColor(value: number): string {
  if (value < THRESHOLD_GREEN) return "bg-green-500";
  if (value < THRESHOLD_YELLOW) return "bg-yellow-500";
  return "bg-red-500";
}

function MetricCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
      <p className="text-xs text-gray-500 uppercase tracking-wide mb-2">{label}</p>
      <p className={`text-2xl font-bold ${getThresholdColor(value)}`}>
        {value.toFixed(1)}%
      </p>
      <div className="mt-2 h-2 bg-gray-800 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-500 ${getBarColor(value)}`}
          style={{ width: `${Math.min(value, 100)}%` }}
        />
      </div>
    </div>
  );
}

function ServiceBadge({ service }: { service: ServiceStatus }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${
        service.running
          ? "bg-green-900/30 text-green-400 border border-green-800"
          : "bg-red-900/30 text-red-400 border border-red-800"
      }`}
    >
      <span
        className={`w-1.5 h-1.5 rounded-full ${
          service.running ? "bg-green-400" : "bg-red-400"
        }`}
      />
      {service.name}
    </span>
  );
}

function ContainerTable({ containers }: { containers: DockerContainer[] }) {
  if (containers.length === 0) {
    return <p className="text-sm text-gray-600">No containers found.</p>;
  }

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-800 text-left text-gray-500">
            <th className="px-4 py-2 font-medium">Name</th>
            <th className="px-4 py-2 font-medium">Status</th>
            <th className="px-4 py-2 font-medium">CPU %</th>
            <th className="px-4 py-2 font-medium">Memory (MB)</th>
          </tr>
        </thead>
        <tbody>
          {containers.map((c) => (
            <tr
              key={c.name}
              className="border-b border-gray-800/50 hover:bg-gray-800/30 transition-colors"
            >
              <td className="px-4 py-2 font-mono text-gray-300">{c.name}</td>
              <td className="px-4 py-2">
                <span
                  className={`text-xs ${
                    c.status.includes("Up") ? "text-green-400" : "text-red-400"
                  }`}
                >
                  {c.status}
                </span>
              </td>
              <td className="px-4 py-2 text-gray-400">{c.cpuPercent.toFixed(1)}%</td>
              <td className="px-4 py-2 text-gray-400">{c.memoryMb.toFixed(0)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function HealthPanel({ serverId }: HealthPanelProps) {
  const { health, isLoading, refresh } = useHealth(serverId);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const handleRefresh = async () => {
    setIsRefreshing(true);
    try {
      await refresh();
    } finally {
      setIsRefreshing(false);
    }
  };

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map((n) => (
            <div key={n} className="bg-gray-900 border border-gray-800 rounded-lg p-4 animate-pulse h-24" />
          ))}
        </div>
      </div>
    );
  }

  if (!health) {
    return (
      <div className="text-center py-12 text-gray-600">
        <p>No health data available.</p>
        <button
          onClick={handleRefresh}
          className="mt-3 bg-blue-600 hover:bg-blue-700 px-4 py-2 rounded-lg text-sm font-medium transition-colors text-white"
        >
          Run Health Check
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Server Health</h2>
        <div className="flex items-center gap-3">
          <span className="text-xs text-gray-500">
            Last check: {new Date(health.checkedAt).toLocaleString()}
          </span>
          <button
            onClick={handleRefresh}
            disabled={isRefreshing}
            className="bg-gray-800 hover:bg-gray-700 disabled:opacity-50 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors"
          >
            {isRefreshing ? "Refreshing..." : "Refresh"}
          </button>
        </div>
      </div>

      {/* Metric Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <MetricCard label="CPU" value={health.cpu} />
        <MetricCard label="Memory" value={health.memory} />
        <MetricCard label="Disk" value={health.disk} />
        <MetricCard label="Swap" value={health.swap} />
      </div>

      {/* Services */}
      {health.services.length > 0 && (
        <div>
          <h3 className="text-sm font-medium text-gray-400 mb-3">Services</h3>
          <div className="flex flex-wrap gap-2">
            {health.services.map((s) => (
              <ServiceBadge key={s.name} service={s} />
            ))}
          </div>
        </div>
      )}

      {/* Docker Containers */}
      {health.containers.length > 0 && (
        <div>
          <h3 className="text-sm font-medium text-gray-400 mb-3">Docker Containers</h3>
          <ContainerTable containers={health.containers} />
        </div>
      )}
    </div>
  );
}
