import { describe, it, expect } from "vitest";
import { validateComposePath } from "../../server/lib/validate-compose-path.js";

describe("validateComposePath (FR-020a)", () => {
  it.each([
    "docker-compose.yml",
    "docker-compose.yaml",
    "services/api/compose.yaml",
    // Case-insensitive extension check (Gemini PR#15 review). On-disk filename
    // preserved verbatim — only the extension match is case-folded.
    "docker-compose.YAML",
    "compose.YML",
    "stack.Yml",
  ])("ok: %s", (input) => {
    const r = validateComposePath(input);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(input);
  });

  it("trims surrounding whitespace", () => {
    const r = validateComposePath("  docker-compose.yml  ");
    expect(r).toEqual({ ok: true, value: "docker-compose.yml" });
  });

  it.each([
    ["../etc/passwd.yml", "unsafe_path"],
    ["a/../b.yaml", "unsafe_path"],
    ["..", "unsafe_path"],
    ["/abs/path.yml", "unsafe_path"],
    ["with\\backslash.yml", "unsafe_path"],
    ["", "unsafe_path"],
    ["nonascii.yml", "unsafe_path"],
  ])("rejects %s with code %s", (input, code) => {
    const r = validateComposePath(input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(code);
  });

  it.each(["compose.txt", "compose.yaml.bak", "compose"])(
    "rejects wrong extension: %s",
    (input) => {
      const r = validateComposePath(input);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("wrong_extension");
    },
  );

  it("rejects paths over 256 chars", () => {
    const long = "a".repeat(252) + ".yml";
    const r = validateComposePath(long);
    // 252 + 4 = 256, just at the boundary → ok
    expect(r.ok).toBe(true);

    const tooLong = "a".repeat(253) + ".yml";
    const r2 = validateComposePath(tooLong);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.code).toBe("too_long");
  });

  it.each([null, undefined, 42, {}, []])("rejects non-string input %p", (input) => {
    const r = validateComposePath(input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("unsafe_path");
  });
});
