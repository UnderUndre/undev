/**
 * Feature 008 T048 — wire-in for cert-expiry probe.
 *
 * The probe (feature 006 / `runCertExpiryProbe`) calls `recordCertObservation`
 * post-handshake. This module:
 *   1. Updates `app_certs.expires_at` + `last_renew_at` on the live cert row
 *      (FR-022 — only forward-moving expiry counts as a renewal).
 *   2. Evaluates alert windows via `cert-expiry-alerter` (T046).
 *   3. Fires Telegram + writes an `app_cert_events` row per fired window.
 *
 * Idempotent — re-firing a window already in `app_cert_events` for this
 * lifecycle is silenced (the alerter receives the firedWindows set).
 */

import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { appCerts, appCertEvents, applications } from "../db/schema.js";
import { evaluateAlertWindows, type AlertWindow } from "./cert-expiry-alerter.js";
import { notifier } from "./notifier.js";
import { logger } from "../lib/logger.js";

export async function recordCertObservation(input: {
  appId: string;
  domain: string;
  validTo: Date;
}): Promise<void> {
  const validToIso = input.validTo.toISOString();

  // 1. Locate the live cert.
  const liveRows = await db
    .select()
    .from(appCerts)
    .where(eq(appCerts.appId, input.appId));
  const live = liveRows.find((r) => r.status === "active" || r.status === "pending");
  if (!live) {
    logger.debug(
      { ctx: "cert-expiry-observation", appId: input.appId },
      "no live cert row — skip observation",
    );
    return;
  }

  const previousExpires = live.expiresAt ? new Date(live.expiresAt).getTime() : 0;
  const now = new Date();
  const isRenewal = input.validTo.getTime() > previousExpires;

  // 2. Update `expires_at` + `last_renew_at` (forward-only).
  await db
    .update(appCerts)
    .set({
      expiresAt: validToIso,
      ...(isRenewal
        ? { lastRenewAt: now.toISOString(), lastRenewOutcome: "success" as const }
        : {}),
      // Promote pending → active when probe sees a valid cert in the wild.
      ...(live.status === "pending" ? { status: "active" as const, issuedAt: live.issuedAt ?? validToIso } : {}),
    })
    .where(eq(appCerts.id, live.id));

  // 3. Evaluate alert windows. firedWindows = set of `app_cert_events` rows
  //    of type `expiry_alert_fired` since the last `lastRenewAt` (lifecycle).
  const firedSince = isRenewal ? now : new Date(live.lastRenewAt ?? live.createdAt);
  const events = await db
    .select()
    .from(appCertEvents)
    .where(
      and(
        eq(appCertEvents.certId, live.id),
        eq(appCertEvents.eventType, "expiry_alert_fired"),
      ),
    );
  const firedWindows = new Set<AlertWindow>();
  for (const e of events) {
    const occurred = new Date(e.occurredAt);
    if (occurred < firedSince) continue;
    const w = (e.eventData as { window?: AlertWindow } | null)?.window;
    if (w) firedWindows.add(w);
  }

  const evalResult = evaluateAlertWindows(
    { expiresAt: validToIso, status: "active" },
    now,
    firedWindows,
  );

  if (evalResult.windowsToFire.length === 0) return;

  const [app] = await db
    .select({ name: applications.name, serverId: applications.serverId })
    .from(applications)
    .where(eq(applications.id, input.appId))
    .limit(1);

  for (const window of evalResult.windowsToFire) {
    const daysLeft = Math.max(0, Math.floor(evalResult.daysLeft ?? 0));
    void notifier
      .notifyCertExpiring({
        appId: input.appId,
        appName: app?.name ?? input.appId,
        domain: input.domain,
        daysLeft,
        windowDays: Number(window.replace("d", "")),
        expiresAtIso: validToIso,
        lastRenewAtIso: live.lastRenewAt,
        certStatus: "active",
        deepLink: `/apps/${input.appId}`,
      })
      .catch((err) =>
        logger.warn(
          { ctx: "cert-expiry-observation-notify", err, certId: live.id },
          "Telegram dispatch failed",
        ),
      );
    await db.insert(appCertEvents).values({
      id: randomUUID(),
      certId: live.id,
      eventType: "expiry_alert_fired",
      eventData: { window, daysLeft },
      actor: "system",
      occurredAt: now.toISOString(),
    });
  }
}
