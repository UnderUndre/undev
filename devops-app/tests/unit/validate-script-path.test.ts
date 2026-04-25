import { describe, it, expect } from "vitest";
import {
  validateScriptPath,
  type ValidateResult,
} from "../../server/lib/validate-script-path.js";

/**
 * Shared fixture array. T006 (parity test) imports this and runs the same
 * fixtures against the client validator. Any drift is caught at commit time.
 */
export interface Fixture {
  label: string;
  input: string | null | undefined;
  expected: ValidateResult;
}

export const FIXTURES: Fixture[] = [
  // ── Empty / whitespace / nullish → null ──────────────────────────────────
  { label: "null", input: null, expected: { ok: true, value: null } },
  { label: "undefined", input: undefined, expected: { ok: true, value: null } },
  { label: "empty string", input: "", expected: { ok: true, value: null } },
  { label: "spaces only", input: "   ", expected: { ok: true, value: null } },
  { label: "tab only", input: "\t", expected: { ok: true, value: null } },

  // ── Traversal ────────────────────────────────────────────────────────────
  {
    label: "leading ..",
    input: "../foo",
    expected: { ok: false, error: "Path cannot contain parent-directory traversal" },
  },
  {
    label: "embedded ..",
    input: "foo/../bar",
    expected: { ok: false, error: "Path cannot contain parent-directory traversal" },
  },
  {
    label: "double ..",
    input: "a/../../b",
    expected: { ok: false, error: "Path cannot contain parent-directory traversal" },
  },
  {
    label: "passwd traversal",
    input: "scripts/../../etc/passwd",
    expected: { ok: false, error: "Path cannot contain parent-directory traversal" },
  },

  // ── Absolute paths ───────────────────────────────────────────────────────
  {
    label: "absolute /etc/passwd",
    input: "/etc/passwd",
    expected: { ok: false, error: "Must be a relative path inside the repo" },
  },
  {
    label: "double-slash netloc",
    input: "//netloc",
    expected: { ok: false, error: "Must be a relative path inside the repo" },
  },
  {
    label: "single slash",
    input: "/",
    expected: { ok: false, error: "Must be a relative path inside the repo" },
  },

  // ── Shell metacharacters ─────────────────────────────────────────────────
  ...(
    [
      ["semicolon", "foo;rm -rf /"],
      ["dollar subshell", "$(id)"],
      ["backtick", "`whoami`"],
      ["pipe", "foo|bar"],
      ["ampersand", "foo&bar"],
      ["redirect out", "foo>out"],
      ["redirect in", "foo<in"],
      ['double quote', 'foo"bar'],
      ["single quote", "foo'bar"],
      ["space", "foo bar"],
      ["backslash (GPT-P1-5)", "foo\\bar"],
      ["open paren (Gemini-PR11)", "foo(bar"],
      ["close paren (Gemini-PR11)", "foo)bar"],
      ["subshell-like (Gemini-PR11)", "(cmd)"],
    ] as const
  ).map(([label, input]) => ({
    label,
    input,
    expected: {
      ok: false,
      error: "Path contains characters that are not allowed",
    } as ValidateResult,
  })),

  // ── Control chars / non-ASCII (rule 3 fires before rule 6) ───────────────
  {
    label: "newline",
    input: "foo\nbar",
    expected: { ok: false, error: "Path must be printable ASCII" },
  },
  {
    label: "null byte",
    input: "foo\0bar",
    expected: { ok: false, error: "Path must be printable ASCII" },
  },
  {
    label: "Cyrillic (GPT-P1-6)",
    input: "скрипты/деплой.sh",
    expected: { ok: false, error: "Path must be printable ASCII" },
  },
  {
    label: "Latin extended",
    input: "scripts/café.sh",
    expected: { ok: false, error: "Path must be printable ASCII" },
  },
  {
    label: "emoji",
    input: "scripts/😀.sh",
    expected: { ok: false, error: "Path must be printable ASCII" },
  },

  // ── Length ───────────────────────────────────────────────────────────────
  {
    label: "exact 256 ASCII",
    input: "a".repeat(256),
    expected: { ok: true, value: "a".repeat(256) },
  },
  {
    label: "257 → reject",
    input: "a".repeat(257),
    expected: { ok: false, error: "Path must be ≤256 characters" },
  },
  {
    label: "512 → reject",
    input: "a".repeat(512),
    expected: { ok: false, error: "Path must be ≤256 characters" },
  },

  // ── Valid paths ──────────────────────────────────────────────────────────
  {
    label: "canonical example",
    input: "scripts/devops-deploy.sh",
    expected: { ok: true, value: "scripts/devops-deploy.sh" },
  },
  {
    label: "nested",
    input: "scripts/nested/path/deploy.sh",
    expected: { ok: true, value: "scripts/nested/path/deploy.sh" },
  },
  { label: "single char", input: "a.sh", expected: { ok: true, value: "a.sh" } },
  {
    label: "hidden-prefix",
    input: "._hidden.sh",
    expected: { ok: true, value: "._hidden.sh" },
  },
  {
    label: "./ allowed (GPT-P1-5)",
    input: "./scripts/deploy.sh",
    expected: { ok: true, value: "./scripts/deploy.sh" },
  },
  {
    label: ". segments allowed",
    input: "./foo/./bar.sh",
    expected: { ok: true, value: "./foo/./bar.sh" },
  },
  {
    label: "trim preserves valid",
    input: "  scripts/deploy.sh  ",
    expected: { ok: true, value: "scripts/deploy.sh" },
  },
];

describe("validateScriptPath (T003/T004)", () => {
  for (const fx of FIXTURES) {
    it(fx.label, () => {
      expect(validateScriptPath(fx.input)).toEqual(fx.expected);
    });
  }
});
