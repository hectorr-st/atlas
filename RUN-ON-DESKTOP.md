# Running Atlas on your own desktop

This is the reliable setup: the automated Chrome window opens **on your screen**,
so you complete the Google / Cloudflare sign-in yourself, once. After that the
session is saved and login is instant.

## 1. Install prerequisites (one time)
- **Google Chrome** — https://www.google.com/chrome/
- **Node.js 18+** — https://nodejs.org/  (verify: `node --version`)

## 2. Get the project onto your computer
Copy the project folder (or unzip `atlas.zip`). Don't copy `node_modules` or
`server/.session` — they're machine-specific and rebuilt locally.

## 3. Install dependencies (one time)
```bash
npm install            # the web UI
cd server && npm install && cd ..   # the automation backend (+ browser engine)
```

## 4. Run it (every time) — two terminals
```bash
# Terminal 1 — backend (opens the real Chrome window)
cd server && npm start

# Terminal 2 — web UI
npm run dev
```
Open the printed URL (usually http://localhost:5173).

## 5. First login
1. Enter the community URL + your email, keep **"Show browser window" ON**.
2. Pick **Sign in with Google** or **Email & password**, click **Open browser & log in**.
3. A Chrome window opens — finish sign-in there (Google password / 2FA, or solve
   any Cloudflare check). The session saves to `server/.session/profile`, so
   future logins are instant.

Then: **Scrape member URLs → Scrape all members** (Stop & keep anytime), write
your message, **Start sending** (Pause/Resume/Stop available mid-run).

## Notes
- **Windows / Mac:** same `npm start` — you do NOT need `xvfb` (that's only for
  headless Linux servers).
- **No Chrome?** set `browserChannel: ''` in `server/config.js` to use the
  bundled engine.
- Your credentials and saved session never leave your computer.
