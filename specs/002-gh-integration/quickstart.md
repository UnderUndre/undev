# Quickstart: GitHub Integration

## Prerequisites

- DevOps Dashboard running at `https://undev.underundre.com`
- GitHub account

## Connect GitHub

1. Go to **github.com** → Settings → Developer settings → **Fine-grained tokens** → Generate new token
2. Set permissions:
   - **Repository access**: All repositories (or select specific ones)
   - **Permissions → Repository permissions**:
     - Contents: **Read-only**
     - Metadata: **Read-only**
     - Commit statuses: **Read-only**
3. Generate and copy the token (`github_pat_...`)
4. Open dashboard → **Settings** → paste token → **Connect**
5. You should see "Connected as @yourusername" with your avatar

## Add App from GitHub

1. Go to **Servers** → select a server → **Apps** → **Add Application**
2. Type repository name in the search box — results appear from GitHub
3. Select a repository — name, URL, and branch auto-populate
4. Fill in: **Remote path** (e.g., `/home/deploy/my-api`) and **Deploy script** (e.g., `scripts/deploy.sh`)
5. Click **Add**

## Deploy a Specific Commit

1. Open an app linked to GitHub
2. See commit history below the deploy section
3. Click **Deploy** on any commit to deploy that specific SHA
4. Or click **Deploy Latest** to deploy HEAD of the branch

## Switch Branch

1. Open app page → branch dropdown (next to app name)
2. Select a different branch
3. Commit history updates — you can now deploy from the new branch
