import { describe, it, expect } from "vitest";
import {
  deriveSlug,
  validateSlug,
  SLUG_REGEX,
} from "../../server/lib/slug.js";

describe("deriveSlug (FR-006)", () => {
  it.each<[string, string]>([
    ["my-app", "my-app"],
    ["MyApp", "myapp"],
    ["CamelCase", "camelcase"],
    ["a---b", "a-b"],
    ["123", "123"],
    ["a", "a"],
    ["under_score", "under-score"],
    ["with.dot", "with-dot"],
    ["spaces and stuff", "spaces-and-stuff"],
    ["-leading-trailing-", "leading-trailing"],
  ])("ascii: %s → %s", (input, expected) => {
    expect(deriveSlug(input)).toBe(expected);
  });

  it.each<[string, string]>([
    ["Café", "cafe"],
    ["Naïve", "naive"],
    ["jalapeño", "jalapeno"],
  ])("latin-extended: %s → %s", (input, expected) => {
    expect(deriveSlug(input)).toBe(expected);
  });

  it("cyrillic transliterates to ASCII", () => {
    const slug = deriveSlug("Мой-Супер-Проект");
    expect(SLUG_REGEX.test(slug)).toBe(true);
    expect(slug.length).toBeGreaterThan(0);
    expect(slug).not.toBe("");
  });

  it("greek transliterates to ASCII", () => {
    const slug = deriveSlug("Αθήνα");
    expect(SLUG_REGEX.test(slug)).toBe(true);
    expect(slug.length).toBeGreaterThan(0);
  });

  it("emoji-only falls back to repo-<hash>", () => {
    const slug = deriveSlug("🔥💯");
    expect(slug.startsWith("repo-")).toBe(true);
    expect(SLUG_REGEX.test(slug)).toBe(true);
  });

  it("empty string falls back to repo-<hash>", () => {
    const slug = deriveSlug("");
    expect(slug.startsWith("repo-")).toBe(true);
    expect(SLUG_REGEX.test(slug)).toBe(true);
  });

  it("all-special-chars falls back to repo-<hash>", () => {
    const slug = deriveSlug("!!!@@@");
    expect(slug.startsWith("repo-")).toBe(true);
  });

  it("CJK without table coverage falls back gracefully", () => {
    const slug = deriveSlug("日本語リポ");
    // Either transliterates or hash-fallback — must satisfy regex either way.
    expect(SLUG_REGEX.test(slug)).toBe(true);
  });

  it("truncates to 64 chars and trims trailing dash", () => {
    const longInput = "a".repeat(80);
    const slug = deriveSlug(longInput);
    expect(slug.length).toBeLessThanOrEqual(64);
    expect(slug.endsWith("-")).toBe(false);
  });

  it("is deterministic — same input → same output", () => {
    const a = deriveSlug("Россия 🚀");
    const b = deriveSlug("Россия 🚀");
    expect(a).toBe(b);
  });

  it("post-condition: every output matches SLUG_REGEX", () => {
    const inputs = [
      "x",
      "my-cool-app",
      "Café",
      "Россия",
      "🔥",
      "",
      "中文",
      "!!!",
      "a".repeat(200),
      "  spaces  ",
      "con", // Windows reserved name — slug derivation does not police it
    ];
    for (const input of inputs) {
      const slug = deriveSlug(input);
      expect(SLUG_REGEX.test(slug)).toBe(true);
    }
  });
});

describe("validateSlug (FR-027)", () => {
  it.each(["my-app", "x", "abc-123", "z9", "a-b-c"])("ok: %s", (s) => {
    expect(validateSlug(s)).toEqual({ ok: true, value: s });
  });

  it.each([
    ["", "Slug cannot be empty"],
    ["..hidden", "forbidden characters"],
    ["with space", "forbidden characters"],
    ["UPPER", "must match"],
    ["with/slash", "forbidden characters"],
    ["dot.in.middle", "forbidden characters"],
  ])("rejects %s", (slug, errSubstring) => {
    const r = validateSlug(slug);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(errSubstring);
  });

  it("rejects slugs over 64 chars", () => {
    const r = validateSlug("a".repeat(65));
    expect(r.ok).toBe(false);
  });
});
