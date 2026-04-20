import React from "react";
import { Link } from "react-router-dom";

type Variant = "not_connected" | "rate_limited" | "token_expired" | "error";

interface Props {
  variant: Variant;
  message?: string;
  className?: string;
}

const DEFAULTS: Record<Variant, { title: string; hint?: React.ReactNode }> = {
  not_connected: {
    title: "GitHub not connected",
    hint: (
      <>
        Connect GitHub in{" "}
        <Link to="/settings" className="underline hover:text-white">
          Settings
        </Link>{" "}
        to use this feature.
      </>
    ),
  },
  rate_limited: {
    title: "GitHub API rate limit exceeded",
    hint: "Wait for reset or reduce polling frequency.",
  },
  token_expired: {
    title: "GitHub token expired or revoked",
    hint: (
      <>
        Update the token in{" "}
        <Link to="/settings" className="underline hover:text-white">
          Settings
        </Link>
        .
      </>
    ),
  },
  error: {
    title: "GitHub API error",
  },
};

export function GitHubWarning({ variant, message, className = "" }: Props) {
  const { title, hint } = DEFAULTS[variant];
  return (
    <div
      role="alert"
      className={`rounded-md border border-amber-900 bg-amber-950/40 px-4 py-3 text-sm ${className}`}
    >
      <div className="font-medium text-amber-200">{title}</div>
      {message && <div className="mt-1 text-amber-300/80">{message}</div>}
      {hint && <div className="mt-1 text-amber-300/80">{hint}</div>}
    </div>
  );
}
