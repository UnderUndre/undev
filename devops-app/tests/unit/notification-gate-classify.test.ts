/** Feature 011 T068 (subset) — classifyTelegramResponse pure-fn invariants. */
import { describe, it, expect } from "vitest";
import { classifyTelegramResponse } from "../../server/services/notification-gate.js";

describe("classifyTelegramResponse", () => {
  it("network/fetch error → transient", () => {
    const cls = classifyTelegramResponse(0, null, new Error("ECONNRESET"));
    expect(cls.kind).toBe("transient");
  });

  it("200 + ok=true → success", () => {
    const cls = classifyTelegramResponse(
      200,
      { ok: true, result: { message_id: 42 } },
      null,
    );
    expect(cls.kind).toBe("success");
  });

  it("429 → transient with retryAfterMs from parameters.retry_after", () => {
    const cls = classifyTelegramResponse(
      429,
      { ok: false, parameters: { retry_after: 5 } },
      null,
    );
    expect(cls.kind).toBe("transient");
    if (cls.kind === "transient") {
      expect(cls.retryAfterMs).toBe(5_000);
    }
  });

  it("500 → transient", () => {
    const cls = classifyTelegramResponse(500, { ok: false }, null);
    expect(cls.kind).toBe("transient");
  });

  it("401 → permanent unauthorized", () => {
    const cls = classifyTelegramResponse(
      401,
      { ok: false, error_code: 401, description: "Unauthorized" },
      null,
    );
    expect(cls.kind).toBe("permanent");
    if (cls.kind === "permanent") {
      expect(cls.reason).toBe("unauthorized");
      expect(cls.tgErrorCode).toBe(401);
    }
  });

  it("403 → permanent forbidden", () => {
    const cls = classifyTelegramResponse(403, { ok: false }, null);
    expect(cls.kind).toBe("permanent");
    if (cls.kind === "permanent") {
      expect(cls.reason).toBe("forbidden");
    }
  });

  it("404 → permanent chat_not_found", () => {
    const cls = classifyTelegramResponse(404, { ok: false }, null);
    expect(cls.kind).toBe("permanent");
    if (cls.kind === "permanent") {
      expect(cls.reason).toBe("chat_not_found");
    }
  });

  it("400 → permanent bad_request", () => {
    const cls = classifyTelegramResponse(400, { ok: false }, null);
    expect(cls.kind).toBe("permanent");
    if (cls.kind === "permanent") {
      expect(cls.reason).toBe("bad_request");
    }
  });

  it("unknown 4xx (e.g. 418) → permanent unknown_4xx", () => {
    const cls = classifyTelegramResponse(418, { ok: false }, null);
    expect(cls.kind).toBe("permanent");
    if (cls.kind === "permanent") {
      expect(cls.reason).toBe("unknown_4xx");
    }
  });

  it("429 without parameters defaults retryAfterMs=1000", () => {
    const cls = classifyTelegramResponse(429, { ok: false }, null);
    expect(cls.kind).toBe("transient");
    if (cls.kind === "transient") {
      expect(cls.retryAfterMs).toBe(1_000);
    }
  });
});
