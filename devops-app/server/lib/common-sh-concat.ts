/**
 * Feature 005 R-003: Build the bash buffer piped over SSH stdin.
 *
 * Layout (three parts, ordered):
 *   1. Preamble:
 *        export YES=true
 *        export CI=true
 *        export SECRET_<NAME>='<shQuoted value>'   (one per envExports entry)
 *        source() / .()  overrides that no-op for *common.sh
 *   2. scripts/common.sh contents (shebang stripped)
 *   3. target script contents (shebang stripped; source lines PRESERVED —
 *      the override turns them into no-ops at runtime)
 *
 * Why the function overrides instead of regex-stripping the `source` line:
 * bash has at least five syntactic forms for sourcing (canonical, POSIX `.`,
 * relative, variable-interpolated, `${BASH_SOURCE%/*}`-based). A function
 * with name `source` and `.` dispatches all of them through one gate without
 * us ever parsing bash source code. See research.md §R-003.
 */

import { shQuote } from "./sh-quote.js";

export interface BuildTransportBufferInput {
  commonSh: string;
  targetSh: string;
  /** Plain name → plain value. Name will be uppercased + SECRET_-prefixed. */
  envExports: Record<string, string>;
}

function stripShebang(s: string): string {
  return s.startsWith("#!") ? s.replace(/^#![^\n]*\n?/, "") : s;
}

export function buildTransportBuffer(input: BuildTransportBufferInput): string {
  const { commonSh, targetSh, envExports } = input;

  const secretLines = Object.entries(envExports)
    .map(([name, value]) => `export ${name}=${shQuote(value)}`)
    .join("\n");

  const preamble = [
    "export YES=true",
    "export CI=true",
    ...(secretLines ? [secretLines] : []),
    "",
    "# Feature 005: intercept common.sh sourcing regardless of syntactic form.",
    "source() {",
    "  case \"$1\" in",
    "    */common.sh|common.sh) return 0 ;;",
    "    *) builtin source \"$@\" ;;",
    "  esac",
    "}",
    ".() {",
    "  case \"$1\" in",
    "    */common.sh|common.sh) return 0 ;;",
    "    *) builtin . \"$@\" ;;",
    "  esac",
    "}",
    "",
  ].join("\n");

  return [
    preamble,
    "# --- begin common.sh (inlined by scripts-runner) ---",
    stripShebang(commonSh),
    "# --- end common.sh ---",
    "",
    "# --- begin target script ---",
    stripShebang(targetSh),
    "# --- end target script ---",
    "",
  ].join("\n");
}
