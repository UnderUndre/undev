/**
 * Feature 008 T015 — Public Suffix List lookup (FR-024 / R-004).
 *
 * Returns the registered domain (the label immediately before the longest
 * matching public suffix). Falls back to last-two-labels when no PSL match.
 *
 * Pure function. No I/O. Snapshot data lives in `psl-snapshot.json` (T001).
 */

// JSON imports require a runtime assertion under Node 20 ESM. Use a default
// import via a relative path that resolves at build time.
import snapshot from "./psl-snapshot.json" with { type: "json" };

interface PslSnapshot {
  _meta: { source: string; snapshotDate: string; note?: string; license?: string };
  suffixes: Record<string, boolean>;
}

const data = snapshot as PslSnapshot;

export function getRegisteredDomain(domain: string): string {
  const lower = domain.toLowerCase().trim();
  if (lower === "") return lower;
  const labels = lower.split(".");
  if (labels.length <= 1) return lower;

  // Walk from full → shorter, find the LONGEST suffix entry in the PSL.
  let longestSuffixLen = 0;
  for (let i = 0; i < labels.length; i++) {
    const candidate = labels.slice(i).join(".");
    if (data.suffixes[candidate] === true) {
      const suffixLen = labels.length - i;
      if (suffixLen > longestSuffixLen) longestSuffixLen = suffixLen;
    }
  }

  if (longestSuffixLen === 0) {
    // No PSL match — last two labels.
    return labels.slice(-2).join(".");
  }

  // Registered = (suffixLen + 1) trailing labels (one label before the suffix).
  const take = Math.min(longestSuffixLen + 1, labels.length);
  return labels.slice(-take).join(".");
}
