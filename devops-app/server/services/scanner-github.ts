/**
 * Normalises a git remote URL to `owner/repo` when it points at github.com.
 * Returns null for non-GitHub URLs (self-hosted, GitLab, Bitbucket, etc.).
 */

const PATTERNS = [
  /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i,
  /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i,
  /^ssh:\/\/git@github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i,
  /^git:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i,
];

export function githubRepoFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  for (const rx of PATTERNS) {
    const m = url.match(rx);
    if (m) return `${m[1]}/${m[2]}`;
  }
  return null;
}
