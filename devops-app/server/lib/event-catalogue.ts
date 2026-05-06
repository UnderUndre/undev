/**
 * Feature 011 T011 — single source of truth for notifiable events.
 *
 * Adding a new event requires a row here with `defaultEnabled` declared;
 * TypeScript enforces presence (interface field non-optional) so a new
 * event without a default fails typecheck before it can be dispatched.
 *
 * Categories:
 *   - failure: things broke; default ON.
 *   - security: state-changing actions worth a paper trail; default ON.
 *   - success: nice-to-know completions; default OFF (avoids noise).
 *   - operational: heads-up reminders (cert expiring, etc.); default ON.
 */

export type EventCategory = "failure" | "security" | "success" | "operational";

export interface EventCatalogueEntry {
  type: string;
  description: string;
  defaultEnabled: boolean;
  category: EventCategory;
}

export const EVENT_CATALOGUE: ReadonlyArray<EventCatalogueEntry> = [
  // Failure events — defaults ON
  { type: "deploy.failed", description: "Deploy failed", defaultEnabled: true, category: "failure" },
  { type: "server.init.failed", description: "Server initialisation failed", defaultEnabled: true, category: "failure" },
  { type: "key.rotation.failed", description: "SSH key rotation failed", defaultEnabled: true, category: "failure" },
  { type: "healthcheck.degraded", description: "App health degraded", defaultEnabled: true, category: "failure" },
  { type: "cert.issuance.failed", description: "TLS cert issuance failed", defaultEnabled: true, category: "failure" },
  { type: "caddy.unreachable", description: "Caddy admin API unreachable", defaultEnabled: true, category: "failure" },

  // Security events — defaults ON
  { type: "server.added", description: "Server added", defaultEnabled: true, category: "security" },
  { type: "server.initialised", description: "Server initialised", defaultEnabled: true, category: "security" },
  { type: "key.rotated", description: "SSH key rotated", defaultEnabled: true, category: "security" },
  { type: "env_vars.changed", description: "App environment variables changed", defaultEnabled: true, category: "security" },

  // Success events — defaults OFF
  { type: "deploy.succeeded", description: "Deploy succeeded", defaultEnabled: false, category: "success" },
  { type: "server.init.succeeded", description: "Server initialisation completed", defaultEnabled: false, category: "success" },
  { type: "healthcheck.recovered", description: "App health recovered", defaultEnabled: false, category: "success" },
  { type: "caddy.recovered", description: "Caddy recovered", defaultEnabled: false, category: "success" },

  // Operational — defaults ON
  { type: "cert.expiring", description: "TLS cert expiring soon", defaultEnabled: true, category: "operational" },
];

const TYPE_INDEX: ReadonlyMap<string, EventCatalogueEntry> = new Map(
  EVENT_CATALOGUE.map((e) => [e.type, e]),
);

export function catalogueHas(type: string): boolean {
  return TYPE_INDEX.has(type);
}

export function catalogueGet(type: string): EventCatalogueEntry | undefined {
  return TYPE_INDEX.get(type);
}
