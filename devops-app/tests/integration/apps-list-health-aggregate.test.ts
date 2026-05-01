/**
 * Feature 006 T025 — Apps list health aggregate contract test.
 *
 * Repo doesn't ship a DOM-rendering harness (no jsdom / @testing-library),
 * so this is a static-source contract test mirroring the pattern used by
 * `rollback-confirm-dialog.test.ts`. We assert that ServerPage:
 *   - imports HealthDot and useChannel
 *   - subscribes to `server-apps-health:<serverId>`
 *   - invalidates the apps query on each event
 *   - renders the aggregate `N/M healthy` text + amber tint marker
 *   - mounts <HealthDot appId={...}> in the apps list rows
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const SERVER_PAGE = path.resolve(
  __dirname,
  "../../client/pages/ServerPage.tsx",
);

function readServerPage(): string {
  return readFileSync(SERVER_PAGE, "utf8");
}

describe("Apps list health aggregate (T025)", () => {
  it("imports HealthDot and useChannel", () => {
    const src = readServerPage();
    expect(src).toMatch(/import\s*\{\s*HealthDot\s*\}\s*from\s*["']\.\.\/components\/apps\/HealthDot/);
    expect(src).toMatch(/import\s*\{\s*useChannel\s*\}\s*from\s*["']\.\.\/hooks\/useWebSocket/);
  });

  it("subscribes to the server-apps-health:<serverId> channel", () => {
    const src = readServerPage();
    expect(src).toMatch(/server-apps-health:\$\{serverId\}/);
  });

  it("invalidates the apps query on each aggregate event", () => {
    const src = readServerPage();
    expect(src).toMatch(/queryClient\.invalidateQueries\(\s*\{\s*queryKey:\s*\["server",\s*serverId,\s*"apps"\]/);
  });

  it("renders aggregate `N/M healthy` text", () => {
    const src = readServerPage();
    // The label is composed via template literal `${healthyCount}/${monitoredApps.length} healthy`.
    expect(src).toMatch(/\$\{healthyCount\}\/\$\{monitoredApps\.length\} healthy/);
  });

  it("flags amber tint when any app is unhealthy", () => {
    const src = readServerPage();
    expect(src).toMatch(/unhealthyCount\s*>\s*0/);
    // Amber tint is exposed via data-attr (testable hook) AND visual classes.
    expect(src).toMatch(/data-server-apps-health-tint/);
    expect(src).toMatch(/border-amber-700/);
  });

  it("mounts <HealthDot appId={app.id}> in the apps list rows", () => {
    const src = readServerPage();
    expect(src).toMatch(/<HealthDot\s+appId=\{app\.id\}\s*\/>/);
  });

  it("excludes monitoringEnabled=false apps from the aggregate denominator", () => {
    const src = readServerPage();
    expect(src).toMatch(/monitoringEnabled\s*!==\s*false/);
  });

  it("does not use dangerouslySetInnerHTML", () => {
    const src = readServerPage();
    expect(src).not.toMatch(/dangerouslySetInnerHTML/);
  });
});
