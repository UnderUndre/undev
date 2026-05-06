/** Feature 011 T042 — .env.example parser invariants. */
import { describe, it, expect } from "vitest";
import { parseEnvExample } from "../../server/services/env-vars-migrator.js";

describe("parseEnvExample", () => {
  it("handles plain KEY=value", () => {
    expect(parseEnvExample("FOO=bar\nBAZ=qux")).toEqual({
      FOO: "bar",
      BAZ: "qux",
    });
  });

  it("strips outer double quotes", () => {
    expect(parseEnvExample('FOO="hello world"')).toEqual({
      FOO: "hello world",
    });
  });

  it("strips outer single quotes", () => {
    expect(parseEnvExample("FOO='hello world'")).toEqual({
      FOO: "hello world",
    });
  });

  it("ignores blank lines and # comments", () => {
    const text = `# top-level comment\n\nFOO=bar\n  \n# another\nBAZ=qux`;
    expect(parseEnvExample(text)).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("strips inline # comments on unquoted values", () => {
    expect(parseEnvExample("FOO=bar # trailing comment")).toEqual({
      FOO: "bar",
    });
  });

  it("preserves # inside quoted values", () => {
    expect(parseEnvExample('FOO="bar#baz"')).toEqual({ FOO: "bar#baz" });
  });

  it("strips leading `export ` prefix", () => {
    expect(parseEnvExample("export FOO=bar")).toEqual({ FOO: "bar" });
  });

  it("skips lines without =", () => {
    expect(parseEnvExample("just-a-line\nFOO=bar")).toEqual({ FOO: "bar" });
  });

  it("skips invalid env names (not POSIX)", () => {
    expect(parseEnvExample("lowercase=val\n1STARTS=v\nFOO=bar")).toEqual({
      FOO: "bar",
    });
  });

  it("skips multi-line (unclosed quote) values without crashing", () => {
    const text = `FOO="line1\nline2"\nBAR=ok`;
    expect(parseEnvExample(text)).toEqual({ BAR: "ok" });
  });

  it("trims trailing whitespace on unquoted values", () => {
    expect(parseEnvExample("FOO=bar   ")).toEqual({ FOO: "bar" });
  });

  it("handles CRLF line endings", () => {
    expect(parseEnvExample("FOO=bar\r\nBAZ=qux\r\n")).toEqual({
      FOO: "bar",
      BAZ: "qux",
    });
  });
});
