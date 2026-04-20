import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api.js";

export interface GitHubConnectionInfo {
  username: string;
  avatarUrl: string;
  tokenExpiresAt: string | null;
  connectedAt: string;
}

export interface GitHubRateLimit {
  remaining: number;
  limit: number;
  resetAt: string;
}

export interface GitHubRepository {
  fullName: string;
  name: string;
  owner: string;
  isPrivate: boolean;
  defaultBranch: string;
  updatedAt: string;
  description: string | null;
}

export interface GitHubBranch {
  name: string;
  isDefault: boolean;
}

export type CommitStatus = "success" | "failure" | "pending" | null;

export interface GitHubCommit {
  sha: string;
  shortSha: string;
  message: string;
  author: string;
  date: string;
  status: CommitStatus;
}

// ── Hooks ───────────────────────────────────────────────────────────────────

export function useGitHubConnection() {
  return useQuery<GitHubConnectionInfo | null>({
    queryKey: ["github", "connection"],
    queryFn: () => api.get<GitHubConnectionInfo | null>("/settings/github"),
  });
}

export function useConnectGitHub() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (token: string) =>
      api.post<GitHubConnectionInfo>("/settings/github", { token }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["github"] });
    },
  });
}

export function useDisconnectGitHub() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.delete<void>("/settings/github"),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["github"] });
    },
  });
}

export function useGitHubRateLimit() {
  return useQuery<GitHubRateLimit>({
    queryKey: ["github", "rate-limit"],
    queryFn: () => api.get<GitHubRateLimit>("/settings/github/rate-limit"),
    refetchInterval: 60_000, // refresh every minute
  });
}

export function useRepoSearch(query: string) {
  return useQuery<GitHubRepository[]>({
    queryKey: ["github", "repos", query],
    queryFn: () =>
      api.get<GitHubRepository[]>(`/github/repos?q=${encodeURIComponent(query)}`),
    enabled: query.trim().length >= 2,
    staleTime: 30_000,
  });
}

export function useBranches(owner: string | undefined, repo: string | undefined) {
  return useQuery<GitHubBranch[]>({
    queryKey: ["github", "branches", owner, repo],
    queryFn: () => api.get<GitHubBranch[]>(`/github/repos/${owner}/${repo}/branches`),
    enabled: Boolean(owner && repo),
  });
}

export function useCommits(
  owner: string | undefined,
  repo: string | undefined,
  branch: string | undefined,
  count = 20,
) {
  const qc = useQueryClient();
  const query = useQuery<GitHubCommit[]>({
    queryKey: ["github", "commits", owner, repo, branch, count],
    queryFn: () =>
      api.get<GitHubCommit[]>(
        `/github/repos/${owner}/${repo}/commits?branch=${encodeURIComponent(branch ?? "")}&count=${count}`,
      ),
    enabled: Boolean(owner && repo && branch),
  });
  return {
    ...query,
    refresh: () =>
      qc.invalidateQueries({ queryKey: ["github", "commits", owner, repo, branch] }),
  };
}
