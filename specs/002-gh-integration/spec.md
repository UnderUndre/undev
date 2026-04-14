# Feature Specification: GitHub Integration

**Version**: 1.0 | **Status**: Draft | **Date**: 2026-04-15

## Problem Statement

The DevOps Dashboard (v0.1) requires manual configuration of applications — users must type repository URLs, branch names, deploy script paths, and remote paths by hand. There is no connection to GitHub, so the dashboard cannot discover repositories, list branches, show commit history, or trigger deployments based on repository events.

Developers need the dashboard to connect to their GitHub account, browse and select repositories, pick branches, and deploy directly — eliminating manual data entry and reducing configuration errors. This also lays groundwork for future features like auto-deploy on push (webhooks).

## User Scenarios

### US-001: Connect GitHub Account

**Actor**: Dashboard admin
**Precondition**: Dashboard is running and admin is authenticated.

1. Admin opens Settings page in the dashboard
2. Admin sees "Connect GitHub" button
3. Admin clicks the button and is redirected to GitHub OAuth authorization page
4. Admin grants access to their repositories (public + private)
5. Dashboard receives and stores the GitHub access token
6. Dashboard shows "Connected as @username" with avatar and list of accessible organizations
7. Admin can disconnect at any time (revoke token)

### US-002: Add Application from GitHub Repository

**Actor**: Dashboard admin
**Precondition**: GitHub account is connected, server is already added.

1. Admin navigates to a server's Apps tab and clicks "Add Application"
2. Instead of typing a repo URL, admin sees a searchable list of their GitHub repositories
3. Admin types to filter repositories by name (search across personal + org repos)
4. Admin selects a repository
5. Dashboard auto-populates: repo name, URL, default branch, and detects available branches
6. Admin selects the branch to deploy from (dropdown with all remote branches)
7. Admin fills remaining fields: remote path on server, deploy script path
8. Admin clicks "Add" — application is created with full GitHub metadata

### US-003: View Commit History and Select Deploy Target

**Actor**: Developer
**Precondition**: Application is linked to a GitHub repository.

1. Developer opens an application page
2. Developer sees recent commit history fetched from GitHub (last 20 commits on the deploy branch)
3. Each commit shows: message, author, date, SHA (short), and CI status (if available)
4. Developer can click "Deploy" on any commit — not just the latest
5. Dashboard passes the selected commit SHA to the deploy process
6. After deployment, the dashboard updates the "current commit" from GitHub metadata

### US-004: Branch Switching

**Actor**: Developer
**Precondition**: Application is linked to a GitHub repository.

1. Developer opens application settings
2. Developer sees current deploy branch with a dropdown to switch
3. Dropdown shows all remote branches fetched from GitHub
4. On branch switch, commit history updates to show commits from the new branch
5. Next deploy will use the newly selected branch

### US-005: Repository Webhook for Auto-Deploy (Optional, v2 Scope)

**Actor**: System (automated)
**Precondition**: Webhook is configured for the repository.

1. Developer pushes code to the deploy branch on GitHub
2. GitHub sends a webhook event to the dashboard
3. Dashboard verifies webhook signature
4. Dashboard automatically triggers a deployment for the matching application
5. Developer receives notification (Telegram) about the auto-deploy

**Note**: This scenario is planned for v2 and should be considered in the design but not implemented in v1.

## Functional Requirements

### GitHub Connection

- **FR-001**: Dashboard must support GitHub OAuth App authentication (not GitHub App — simpler setup for self-hosted)
- **FR-002**: OAuth flow must request `repo` scope (read access to public and private repositories)
- **FR-003**: Access token must be stored securely (encrypted in database)
- **FR-004**: Dashboard must display connected GitHub username and avatar after successful auth
- **FR-005**: Admin must be able to disconnect GitHub at any time (deletes stored token)
- **FR-006**: Dashboard must handle token expiration/revocation gracefully (prompt to reconnect)

### Repository Discovery

- **FR-010**: Dashboard must list all repositories accessible to the connected GitHub user
- **FR-011**: Repository list must include both personal and organization repositories
- **FR-012**: Repository list must be searchable/filterable by name (client-side filtering is acceptable for <500 repos)
- **FR-013**: Each repository entry must display: name, owner, visibility (public/private), default branch, last updated date
- **FR-014**: Repository list must be paginated or lazily loaded (GitHub API returns max 100 per page)

### Branch and Commit Data

- **FR-020**: Dashboard must fetch all remote branches for a selected repository
- **FR-021**: Dashboard must fetch recent commits (last 20) for the selected branch
- **FR-022**: Each commit must display: message (first line), author name, date, short SHA
- **FR-023**: If GitHub Actions CI is configured, commit status (success/failure/pending) should be displayed
- **FR-024**: Branch and commit data must refresh when the user opens the application page (not cached indefinitely)

### Application Linking

- **FR-030**: When adding an application, the user must be able to select a repository from GitHub instead of typing a URL
- **FR-031**: Selecting a repository must auto-populate: application name, repository URL, default branch
- **FR-032**: Manual entry of repository URL must still be supported (fallback for non-GitHub repos or disconnected state)
- **FR-033**: Application entity must store a reference to the GitHub repository (owner/repo) for API calls

### Deploy Integration

- **FR-040**: Deploy dialog must show a commit picker when GitHub is connected (select specific commit to deploy)
- **FR-041**: Deploying a specific commit must pass the SHA to the deploy process
- **FR-042**: After successful deploy, dashboard must update the application's current commit from the deploy result
- **FR-043**: Deploy dialog must still support deploying "latest" (HEAD of branch) without selecting a specific commit

## Success Criteria

- **SC-001**: Admin can connect GitHub account in under 1 minute (click → authorize → connected)
- **SC-002**: Repository search returns results within 2 seconds for up to 500 repositories
- **SC-003**: Adding an application from GitHub requires filling only 2 fields manually (remote path + deploy script) instead of 6
- **SC-004**: Developers can select and deploy any of the last 20 commits from the dashboard
- **SC-005**: Branch switching updates commit history within 3 seconds
- **SC-006**: Manual URL entry continues to work for non-GitHub repositories (backward compatibility)

## Out of Scope (v1)

- GitHub webhooks for auto-deploy on push (v2 — US-005)
- GitHub Actions integration (triggering workflows from dashboard)
- Pull request previews or review integration
- GitHub Releases / Tags management
- Multi-provider support (GitLab, Bitbucket) — GitHub only in v1
- GitHub App installation flow (using simpler OAuth App)
- Repository creation or management from dashboard
- Code browsing or diff viewing

## Key Entities

### GitHubConnection

Represents the link between the dashboard and a GitHub account.

- **Token**: Encrypted OAuth access token
- **Username**: GitHub username
- **AvatarUrl**: User's GitHub avatar
- **ConnectedAt**: When the connection was established
- **Scopes**: Granted OAuth scopes

### Repository (transient, from API)

Not stored in database — fetched from GitHub API on demand.

- **FullName**: "owner/repo"
- **Name**: Repository name
- **Owner**: Owner login
- **Private**: Boolean
- **DefaultBranch**: e.g., "main"
- **UpdatedAt**: Last push date

### Application (extended)

Existing entity, extended with:

- **GitHubRepo**: "owner/repo" reference (nullable — for non-GitHub apps)

## Dependencies

- DevOps Dashboard v0.1 (001-devops-app) must be deployed and functional
- GitHub OAuth App must be created by the admin (Client ID + Client Secret)
- Dashboard must be accessible via HTTPS (required for OAuth callback)

## Assumptions

- Single GitHub account per dashboard instance (admin connects once, all users see the same repos)
- GitHub API rate limit (5,000 requests/hour for authenticated users) is sufficient for dashboard usage
- Repository data is fetched on-demand, not synced/cached long-term
- OAuth App registration is a one-time manual setup by the admin (documented in quickstart)
- Dashboard already has HTTPS via Caddy (established in 001-devops-app deployment)
