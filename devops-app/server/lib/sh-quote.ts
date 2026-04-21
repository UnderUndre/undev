/**
 * POSIX single-quote shell escaping.
 *
 * Wraps the input in single quotes and escapes any embedded single quotes via
 * the `'\''` (close-quote → literal-quote → open-quote) sequence. Safe for any
 * byte string — bash never interprets metacharacters inside single quotes.
 *
 * Example:
 *   shQuote("O'Hara") // => "'O'\\''Hara'"
 *   shQuote("") // => "''"
 *
 * Used as the sole quoting path for non-secret params serialised into the
 * bash buffer piped to `bash -s` over SSH stdin (feature 005).
 */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
