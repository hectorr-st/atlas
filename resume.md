# Atlas — deploy status & handoff

**Last updated:** 2026-09-03 ~05:10 UTC

## Goal

Get the frontend change in `f7b55fd` live on <https://atlas-aoicom.vercel.app>.

## Current state: NOT deployed

The live site is stale. This was verified against the server, not a browser
refresh, so it is not a caching illusion:

| | Commit | JS bundle | Built |
|---|---|---|---|
| Local `main` | `f7b55fd` | `index-Bcj-c5cO.js` | just now, locally |
| **Live on Vercel** | older | `index-Co49tQs3.js` | `Last-Modified: 03:56 UTC` |

The deployed build predates the push (~04:21 UTC) by about 25 minutes.

### What is missing from the live site

`f7b55fd` touched `src/App.tsx` (plus `server/`, which is not deployed):

- new **"Members at a time"** input — parallel tabs, 1–8, default 3, sent to
  the backend as `concurrency`
- send delay minimum dropped from `2`s to `0`s, default `10` → `0`

## The build is fine

Not a failing Vercel build — the same build succeeds locally:

```
npx tsc --noEmit -p tsconfig.app.json   # clean, exit 0
npm run build                           # ok, ~2m 9s, 1470 modules
```

## Root cause: the GitHub remote is unreachable

This is the blocker, and it likely explains the dead Vercel webhook too.

```
$ git ls-remote origin
ERROR: Repository not found.
```

Ruled out as causes:

- **SSH auth works** — `ssh -T git@github.com` → `Hi aoisuzi! You've successfully authenticated`
- **Network works** — `git ls-remote https://github.com/git/git.git` returns fine
- **The push did happen** — local reflog: `f7b55fd refs/remotes/origin/main@{0}: update by push`

So `f7b55fd` *was* pushed to `git@github.com:hectorr-st/atlas.git`, but the
account this machine authenticates as (`aoisuzi`) can no longer see that path.
GitHub returns "Repository not found" rather than "forbidden" for private repos,
so this means **renamed, transferred, deleted, or access revoked** — and it
changed within roughly 40 minutes of the successful push.

If the repo was renamed or the Vercel GitHub App lost access, the build webhook
goes dead, which matches the symptom exactly. Reconnecting the repo inside
Vercel will not stick until the GitHub side is resolved.

Note: `hectorr-st` is a different account from `aoisuzi`, i.e. pushing as a
collaborator on someone else's repo. If so, only that owner can restore access
or reconnect the Vercel Git integration.

## Open question — answer this first

Open <https://github.com/hectorr-st/atlas> signed in as `aoisuzi`:

- **404** → renamed/deleted/transferred, or access removed. Need the new URL or
  restored access before anything can deploy.
- **Loads, `f7b55fd` on `main`** → GitHub side is fine; it is only this
  machine's SSH key that lost access. Investigate the Vercel webhook instead.
- **Redirects elsewhere** → renamed. Run `git remote set-url origin <new>` and
  reconnect Vercel to the new path.

## Deploying, once GitHub is sorted

Vercel CLI is installed at `node_modules/.bin/vercel` (v59.11.2).
`package.json` was deliberately reverted so the CLI is **not** a devDependency —
otherwise Vercel's own build would install it needlessly.

Currently `vercel whoami` → **`Logged out.`** There are no credentials on this
machine and no `.vercel/` link directory.

Login needs a real TTY (it fails with `Worker timed out after 10 seconds` when
run non-interactively), so run this in a normal terminal:

```powershell
node_modules\.bin\vercel login     # Continue with GitHub
node_modules\.bin\vercel link      # existing project → atlas-aoicom
node_modules\.bin\vercel --prod
```

### Verify the deploy actually landed

Check the served bundle rather than reloading the page:

```powershell
curl.exe -s https://atlas-aoicom.vercel.app/ | Select-String "assets/index"
```

- `index-Co49tQs3.js` → still stale, deploy did not take
- `index-Bcj-c5cO.js` → success

Visually: the **"Members at a time"** field appears, and the delay input accepts
`0` where it previously forced a minimum of `2`.

## Caveat on "Redeploy"

If the Vercel project turns out to have **no** Git repository connected, do not
just press **Redeploy** on the last deployment — with no Git link it re-serves
the *same stale files* and nothing changes. Connect the repo instead
(Project → Settings → Git → Connect Git Repository).

If it *is* connected, check on that same page:

- **Production Branch** is `main` (not `master`) — otherwise pushes only ever
  produce previews
- **Ignored Build Step** — a skip command here cancels builds silently
- **Deployments** tab — look for a run near 04:21 UTC with status *Error* or
  *Canceled* and read its log

## Project notes

- Frontend is a static SPA; the backend is **not** hosted — each user runs
  `cd server && npm start` locally and the hosted page calls their own
  `http://localhost:3001`. See [HOSTING.md](HOSTING.md).
- No `vercel.json`; Vercel auto-detects the Vite preset and `dist` output.
- The backend allow-lists calling origins; `https://atlas-aoicom.vercel.app` is
  already in `server/config.js`.
