# Hosting the Atlas UI

The UI is a static site. The backend is **not hosted** — it runs on the machine
of whoever is using Atlas, because it drives a real Chrome window that a person
signs into. So: deploy `dist/` to any static host, and everyone still runs
`cd server && npm start` locally.

Requests go **from the hosted page to the user's own `http://localhost:3001`**.
The page is served from the internet; the work happens on their desk.

## 1. Build

```bash
npm run build          # → dist/
```

The backend URL is baked in at build time and defaults to
`http://localhost:3001`. Only override it if your users run the backend
somewhere else:

```bash
# .env (or your host's build-environment settings)
VITE_API_URL=http://localhost:4000
```

## 2. Deploy `dist/`

Any static host works — no server-side rendering, no API routes, no redirects
file (the app is a single page with no router).

| Host | Setup |
|---|---|
| **Netlify** | Build command `npm run build`, publish directory `dist` |
| **Vercel** | Framework preset **Vite**, output directory `dist` — this project is deployed at <https://atlas-aoicom.vercel.app> |
| **Cloudflare Pages** | Build command `npm run build`, output directory `dist` |
| **GitHub Pages** | Push `dist/` to `gh-pages`; set `base` in `vite.config.ts` if the site lives under a subpath |

## 3. Allow your site's origin in the backend

The API can send DMs as you and has no login of its own, so it allow-lists who
may call it. Every `localhost` / `127.0.0.1` port is trusted automatically; your
hosted origin has to be named. Either edit [`server/config.js`](server/config.js):

```js
allowedOrigins: ['https://atlas.netlify.app'],
```

`https://atlas-aoicom.vercel.app` is already in there. To use a different or
additional origin — a Vercel preview URL, say — set the env var instead:

```powershell
$env:ATLAS_ALLOWED_ORIGINS = 'https://atlas-aoicom.vercel.app,https://atlas-git-x-you.vercel.app'
cd server; npm start
```

Scheme + host, no trailing slash. The backend prints the origins it accepts on
startup, and logs a one-line warning the first time it blocks one — check that
console before assuming the backend is down.

## 4. Run the backend, open the site

```bash
cd server && npm start
```

Then open your hosted URL. Everything else — login, scrape, send — works exactly
as it does locally.

## Known limits of this setup

- **Chrome and Firefox only.** An HTTPS page is allowed to call
  `http://localhost` because loopback counts as a trustworthy origin. **Safari
  blocks it**, so Safari users must run the UI locally with `npm run dev`.
- **Private Network Access.** Chrome treats "public page → private address" as
  worth a preflight; the backend answers it, but this area of Chrome is still
  changing and a future release may add a user permission prompt.
- **Still one user per backend.** Hosting the page does not make Atlas
  multi-user: each person's backend has its own browser profile, own saved
  session, and handles one run at a time.
- **HTTP page, HTTPS site.** If you ever host the frontend over plain HTTP, the
  browser's protections above do not apply — but neither does any of the
  security that makes serving it publicly reasonable. Keep the site on HTTPS.
