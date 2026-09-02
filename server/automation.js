import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { selectors, config } from './config.js';

// Anchor the session dir to THIS file, not process.cwd(). Started from the repo
// root (`node server/server.js` rather than `cd server && npm start`) a
// cwd-relative path put the Chrome profile in the project root, where
// .gitignore does not cover it — so the login cookies were one `git add -A`
// away from being committed — and where Vite's file watcher hit the locked
// profile files and crashed the dev server.
const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));

// ─── Shared browser state ────────────────────────────────────────────────────
// We use a PERSISTENT browser profile (a real on-disk Chrome user-data dir).
// This keeps the Cloudflare "clearance" cookie and the Circle login between
// runs, so the human-check stops reappearing after you pass it once.
let context = null;
// The CDP handle when we ATTACHED to a Chrome someone else started. Kept apart
// from `context` because it decides who may close the browser: a browser we
// attached to is not ours to close.
let browser = null;
// How the cached context was obtained — 'attached' | 'headed' | 'headless'. A
// live browser cannot be switched between these, so this is what tells us to
// tear down and start over.
let contextMode = null;
// Every step — the login, the member scrape, and each DM — drives this ONE tab.
// A campaign used to open and close a tab per member, which flickers the window
// and steals focus on every iteration; reusing one tab keeps the whole run in
// place where you can actually watch it. Reset whenever the context goes away.
let sharedPage = null;

// A run is cancellable via this flag, flipped by stop().
let stopRequested = false;
export function requestStop() {
  stopRequested = true;
}

// A run can be paused/resumed without ending it.
let paused = false;
export function setPaused(value) {
  paused = value;
}

// The per-message delay (seconds) is live-adjustable mid-run: the send loop
// re-reads it on every wait tick, so changing it (even while paused) takes
// effect immediately on resume.
let currentDelaySeconds = 0;
export function setDelay(seconds) {
  const n = Number(seconds);
  if (!Number.isNaN(n) && n >= 0) currentDelaySeconds = n;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Try a list of candidate selectors and return the first visible one, or null.
//
// All candidates are waited on CONCURRENTLY, then awaited in list order. That
// keeps the documented "first match in the list wins" priority while costing
// `timeout` in total instead of `candidates.length * timeout`. It matters most
// in the miss case: loggedInMarker has 8 candidates, so the sequential version
// burned 24s per isLoggedIn() call — inside a 2s polling loop.
async function findFirst(scope, candidates, { timeout = 1500 } = {}) {
  const attempts = candidates.map((sel) => {
    // filter({visible}) BEFORE first(). Plain .first() takes the first match in
    // DOM ORDER and then waits for that one element to appear — so a hidden
    // duplicate ahead of the real control (a responsive variant, a collapsed
    // menu, an unrendered template) made the whole lookup time out with a
    // perfectly visible button sitting on the page. That is what reported
    // "no message button" for members who plainly had one.
    const loc = scope.locator(sel).filter({ visible: true }).first();
    return loc.waitFor({ state: 'visible', timeout }).then(
      () => loc,
      () => null
    );
  });
  for (const attempt of attempts) {
    const loc = await attempt;
    if (loc) return loc;
  }
  return null;
}

// Playwright errors carry a multi-line "Call log:" trailer with ANSI colour
// codes in it. Piped into the UI's log panel that renders as several lines of
// `+[2m` noise around the one sentence that matters, so keep just that.
function briefError(err) {
  return String(err?.message ?? err)
    .split(/\r?\nCall log:/)[0]
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;]*m/g, '')
    .trim();
}

function normalizeBase(url) {
  const trimmed = url.trim().replace(/\/+$/, '');
  // The UI accepts a bare hostname ("community.iaug.org" — no scheme). Playwright
  // rejects that outright ("Cannot navigate to invalid URL") and `new URL()` on it
  // throws, which silently left the host empty in the login wait loop below. So
  // settle the scheme once, here, where every caller goes through.
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

// Canonical form of a profile URL for history comparison (drop query/hash/slash).
function normalizeProfileUrl(url) {
  return url.trim().split(/[?#]/)[0].replace(/\/+$/, '');
}

// ─── "Already-sent" history (persisted per community+account) ────────────────

// Resolve a path inside the session dir, creating the dir on first use only.
let sessionDirReady = false;
function sessionPath(...parts) {
  const dir = path.resolve(SERVER_DIR, config.sessionDir);
  if (!sessionDirReady) {
    fs.mkdirSync(dir, { recursive: true });
    sessionDirReady = true;
  }
  return path.join(dir, ...parts);
}

function historyFileFor(communityUrl, email) {
  const key = crypto
    .createHash('sha256')
    .update(`${communityUrl}::${email}`)
    .digest('hex')
    .slice(0, 16);
  return sessionPath(`sent-${key}.json`);
}

function loadHistory(file) {
  try {
    return new Set(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return new Set();
  }
}

function saveHistory(file, set) {
  try {
    fs.writeFileSync(file, JSON.stringify([...set]));
  } catch {
    /* ignore */
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Campaign history (per community), persisted across runs ─────────────────

function campaignsFile() {
  return sessionPath('campaigns.json');
}

function loadCampaigns() {
  try {
    return JSON.parse(fs.readFileSync(campaignsFile(), 'utf8'));
  } catch {
    return [];
  }
}

function recordCampaign(rec) {
  try {
    const all = loadCampaigns();
    all.push(rec);
    fs.writeFileSync(campaignsFile(), JSON.stringify(all));
  } catch {
    /* ignore */
  }
}

// Aggregate raw runs by community for the dashboard.
export function getCampaignHistory() {
  const byCommunity = new Map();
  const aggFor = (url) => {
    let agg = byCommunity.get(url);
    if (!agg) {
      agg = {
        communityUrl: url,
        runs: 0,
        totalMembers: 0,
        processed: 0,
        sent: 0,
        skipped: 0,
        failed: 0,
        lastRun: null,
      };
      byCommunity.set(url, agg);
    }
    return agg;
  };

  for (const r of loadCampaigns()) {
    const agg = aggFor(r.communityUrl);
    agg.runs += 1;
    agg.totalMembers += r.total || 0;
    agg.processed += (r.sent || 0) + (r.skipped || 0) + (r.failed || 0);
    agg.sent += r.sent || 0;
    agg.skipped += r.skipped || 0;
    agg.failed += r.failed || 0;
    if (!agg.lastRun || r.finishedAt > agg.lastRun) agg.lastRun = r.finishedAt;
  }
  // Merge in communities that have been SCRAPED (member lists saved), even if
  // no send campaign has run for them yet.
  for (const [url, data] of Object.entries(loadMembersStore())) {
    const agg = aggFor(url);
    agg.scrapedMembers = (data.urls || []).length;
    if (data.scrapedAt && (!agg.lastRun || data.scrapedAt > agg.lastRun)) {
      agg.lastRun = data.scrapedAt;
    }
  }

  return [...byCommunity.values()]
    .map((a) => ({
      ...a,
      scrapedMembers: a.scrapedMembers || 0,
      completionRate: a.totalMembers ? Math.round((a.processed / a.totalMembers) * 100) : 0,
    }))
    .sort((a, b) => (b.lastRun || '').localeCompare(a.lastRun || ''));
}

// ─── Saved member lists (per community), persisted across runs ───────────────

function membersFile() {
  return sessionPath('members.json');
}

function loadMembersStore() {
  try {
    return JSON.parse(fs.readFileSync(membersFile(), 'utf8'));
  } catch {
    return {};
  }
}

function saveMembersFor(communityUrl, urls) {
  try {
    const store = loadMembersStore();
    store[normalizeBase(communityUrl)] = {
      urls,
      scrapedAt: new Date().toISOString(),
    };
    fs.writeFileSync(membersFile(), JSON.stringify(store));
  } catch {
    /* ignore */
  }
}

// Public: the saved member list for a community (empty if never scraped).
export function getMembersFor(communityUrl) {
  const store = loadMembersStore();
  return store[normalizeBase(communityUrl)] || { urls: [], scrapedAt: null };
}

// ─── Browser lifecycle ───────────────────────────────────────────────────────

const cdpEndpoint = () => `http://127.0.0.1:${config.debugPort}`;

// Ask Chrome's debug endpoint who it is. Doubles as the "is it up yet?" probe,
// so a closed port is an expected answer (null), not an error.
async function probeCdp(timeoutMs = 1200) {
  try {
    const res = await fetch(`${cdpEndpoint()}/json/version`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

function findChromeExe() {
  if (config.chromePath) return config.chromePath;
  const candidates = [
    process.env.PROGRAMFILES,
    process.env['PROGRAMFILES(X86)'],
    process.env.LOCALAPPDATA,
  ]
    .filter(Boolean)
    .map((root) => path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  candidates.push(
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable'
  );
  return candidates.find((p) => fs.existsSync(p)) || null;
}

// Open Chrome with its debug port listening, DETACHED so the window outlives
// this backend — a browser that dies with the server is exactly what attaching
// gets us away from. Returns once the port answers.
async function startDebugChrome(log) {
  const exe = findChromeExe();
  if (!exe) {
    throw new Error('Could not find Chrome — install it, or set chromePath in server/config.js.');
  }
  const dir = config.chromeUserDataDir || sessionPath('profile');
  fs.mkdirSync(dir, { recursive: true });
  log(`Opening Chrome with remote debugging on port ${config.debugPort}...`, 'info');
  spawn(
    exe,
    [
      `--remote-debugging-port=${config.debugPort}`,
      // Not optional: since Chrome 136 the browser REFUSES to expose the debug
      // port for its default user-data-dir, so pointing somewhere else is what
      // makes the port open at all.
      `--user-data-dir=${dir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-blink-features=AutomationControlled',
    ],
    { detached: true, stdio: 'ignore' }
  ).unref();

  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    await sleep(500);
    const info = await probeCdp();
    if (info) return info;
  }
  throw new Error(
    `Chrome opened but port ${config.debugPort} never answered. If Chrome was already ` +
      'running on that same profile it just added a tab to the existing window instead ' +
      'of starting a debuggable one — quit Chrome completely, then try again.'
  );
}

// Attach to a Chrome that is ALREADY OPEN, starting one only when nothing is
// listening. We reuse that browser's DEFAULT context, so the run happens in a
// new tab of the window already on screen, carrying whatever logins it has —
// and the window stays put when this backend stops.
async function attachContext(log) {
  let info = await probeCdp();
  if (info) log(`Attaching to the Chrome already open (${info.Browser}).`, 'success');
  else info = await startDebugChrome(log);

  browser = await chromium.connectOverCDP(cdpEndpoint());
  // Playwright does not OWN this browser. If the person closes Chrome, or the
  // socket drops, clear the cached handles so the next run reconnects instead
  // of driving a dead one.
  browser.on('disconnected', () => {
    browser = null;
    context = null;
    contextMode = null;
    sharedPage = null;
  });
  return browser.contexts()[0] || (await browser.newContext());
}

// The fallback: a browser Playwright launches and owns, from a persistent
// on-disk profile. Still the only option for headless runs, which by definition
// have no visible window to attach to.
async function launchContext(wantHeaded, log) {
  const profileDir = sessionPath('profile');
  fs.mkdirSync(profileDir, { recursive: true });
  const hadProfile = fs.existsSync(path.join(profileDir, 'Default'));

  log(`Launching browser (${wantHeaded ? 'visible' : 'headless'})...`, 'info');
  let ctx;
  try {
    ctx = await chromium.launchPersistentContext(profileDir, {
      headless: !wantHeaded,
      // A real Chrome profile + the real Chrome channel is the most reliable way
      // past Cloudflare's "Verifying you are a human" managed challenge.
      channel: config.browserChannel || undefined,
      viewport: { width: 1280, height: 800 },
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
        '--start-maximized',
      ],
    });
  } catch (err) {
    if (wantHeaded && /display|x11|cannot open/i.test(err.message)) {
      throw new Error(
        'Cannot open a visible browser — no graphical display found. Run the backend ' +
          'from your desktop (a terminal inside your logged-in session), not over SSH/headless. ' +
          'Or turn OFF "Show browser window" to run headless (only works once a session is saved).'
      );
    }
    throw err;
  }

  // If the window is closed (by hand, or Chrome crashes), drop the stale
  // singleton so the next attempt relaunches cleanly.
  ctx.once('close', () => {
    context = null;
    contextMode = null;
    sharedPage = null;
  });
  if (hadProfile) log('Reusing saved browser profile (login + Cloudflare clearance).', 'info');
  return ctx;
}

async function ensureContext({ headed, log }) {
  const wantHeaded = !!headed;
  // Attaching means driving a visible window, so it can only serve a headed run.
  const mode =
    config.attachToChrome && wantHeaded ? 'attached' : wantHeaded ? 'headed' : 'headless';

  // A live browser can't be flipped between these, and the context is cached for
  // the life of the process. So a headless scrape left a headless browser cached
  // and the next login with "Show browser window" ON silently reused it — no
  // window ever opened, and a login you cannot see is a login you cannot finish.
  if (context && contextMode !== mode) {
    log(`Switching browser to ${mode} mode...`, 'info');
    await shutdown();
  }
  if (context) return context;

  context = mode === 'attached' ? await attachContext(log) : await launchContext(wantHeaded, log);
  contextMode = mode;
  context.setDefaultTimeout(config.actionTimeoutMs);
  // Hide the navigator.webdriver flag that automated Chromium exposes.
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  return context;
}

// The single tab every step runs in: the login, the member scrape, and each DM
// all drive this one page instead of opening their own.
async function getPage(ctx = context) {
  if (sharedPage && !sharedPage.isClosed()) return sharedPage;
  // When attached, every other tab is one the person is actually using — never
  // take one of those over, always add our own. A browser we launched ourselves
  // opens with one blank tab, so adopt that rather than stranding it beside the
  // tab we work in.
  const blank =
    contextMode === 'attached'
      ? null
      : ctx.pages().find((p) => !p.isClosed() && p.url() === 'about:blank');
  sharedPage = blank || (await ctx.newPage());
  await sharedPage.bringToFront().catch(() => {});
  // Nothing closes the tab between steps any more, and page.close() skipped
  // beforeunload handlers while a navigation does not — so a composer left
  // holding text can now raise "Leave site?" and block the next member forever.
  // Accept those; keep Playwright's default (dismiss) for anything else.
  sharedPage.on('dialog', (d) => {
    (d.type() === 'beforeunload' ? d.accept() : d.dismiss()).catch(() => {});
  });
  return sharedPage;
}

export async function shutdown() {
  try {
    // Close only a browser we LAUNCHED. An attached one belongs to the person at
    // the keyboard, and browser.close() over CDP is documented as closing the
    // connection but observably takes Chrome down with it — so on the attached
    // path we close nothing but our own tab and simply drop the handles. Ctrl+C
    // on the backend must not take their window and tabs with it.
    if (contextMode === 'attached') await sharedPage?.close().catch(() => {});
    else await context?.close();
  } catch {
    /* ignore */
  }
  browser = null;
  context = null;
  contextMode = null;
  sharedPage = null;
}

// ─── Login ───────────────────────────────────────────────────────────────────

async function isLoggedIn(page) {
  // Only the URL PATH matters — if we're literally on the sign-in form, we're
  // not logged in. The `?post_login_redirect=...` QUERY param is NOT a reliable
  // negative: some communities keep it on authenticated pages too. So we decide
  // by the actual page content (markers below).
  let pathname = '';
  try {
    pathname = new URL(page.url()).pathname;
  } catch {
    /* ignore */
  }
  if (/\/(sign_in|users\/sign_in|login)\b/i.test(pathname)) return false;
  const title = await page.title().catch(() => '');
  if (/just a moment|verifying|attention required/i.test(title)) return false;
  const marker = await findFirst(page, selectors.login.loggedInMarker, { timeout: 3000 });
  return marker !== null;
}

// Sign-in does NOT always finish in the tab we opened: Google's OAuth popup
// commonly lands back on the community and closes itself, and a fully-manual
// sign-in can happen in any tab of the window. Polling only our own tab meant a
// login that plainly succeeded on screen still timed out with "Login was not
// completed in time". So scan every open page, skipping the ones not on the
// community host (a blank tab, or Google's domain) — that pre-filter keeps the
// scan to the one or two tabs worth a 3s marker probe.
async function findLoggedInPage(ctx, host) {
  for (const p of ctx.pages()) {
    if (p.isClosed()) continue;
    let url = '';
    try {
      url = p.url();
    } catch {
      continue;
    }
    if (host && !url.includes(host)) continue;
    if (await isLoggedIn(p).catch(() => false)) return p;
  }
  return null;
}

async function login({ communityUrl, email, password, headed, log }) {
  const base = normalizeBase(communityUrl);
  const ctx = await ensureContext({ headed, log });
  const page = await getPage(ctx);

  // If the saved session is still valid, skip the login form entirely.
  try {
    await page.goto(base, { waitUntil: 'domcontentloaded' });
  } catch (err) {
    throw new Error(`Could not open ${base} — check the community URL. (${briefError(err)})`);
  }
  await page.waitForTimeout(3500); // let the SPA render before checking markers
  if (await isLoggedIn(page)) {
    log('Already logged in.', 'success');
    return true;
  }

  // Open the sign-in page.
  log('Opening the sign-in page...', 'info');
  await page
    .goto(base + selectors.login.path, { waitUntil: 'domcontentloaded' })
    .catch(() => {});
  await page.waitForTimeout(1500);

  // Pick a sign-in method, best-effort and NEVER hard-failing:
  //  1. If the community offers "Sign in with Google", click it and pre-fill
  //     your email on Google's page — you finish with password / 2FA.
  //  2. Otherwise try to auto-fill the email/password form.
  //  3. Otherwise just let you log in by hand in the visible window.
  let autoFilled = false;
  let googleUsed = false;
  try {
    const googleBtn = await findFirst(page, selectors.login.googleButton, { timeout: 3000 });
    if (googleBtn) {
      log('Starting Google sign-in...', 'info');
      let popup = null;
      page.once('popup', (p) => {
        popup = p;
      });
      await googleBtn.click().catch(() => {});
      await page.waitForTimeout(2500);
      const gPage = popup || page;
      if (email) {
        const chooser = await findFirst(gPage, [`[data-identifier="${email}"]`], {
          timeout: 3000,
        });
        if (chooser) {
          await chooser.click().catch(() => {});
          log('Selected your Google account — finish in the window.', 'info');
        } else {
          const emailInput = await findFirst(
            gPage,
            ['input[type="email"]', '#identifierId'],
            { timeout: 6000 }
          );
          if (emailInput) {
            await emailInput.fill(email);
            const next = await findFirst(
              gPage,
              ['#identifierNext button', '#identifierNext', 'button:has-text("Next")'],
              { timeout: 2500 }
            );
            if (next) await next.click().catch(() => {});
            log('Entered your email in Google — finish sign-in in the window.', 'info');
          }
        }
      }
      googleUsed = true;
      log('Complete Google sign-in in the window (password / 2FA if asked).', 'warn');
    } else {
      // No Google button → best-effort email/password form auto-fill.
      const emailFirst = await findFirst(page, selectors.login.emailFirstButton, {
        timeout: 2500,
      });
      if (emailFirst) {
        await emailFirst.click();
        await page.waitForTimeout(1500);
      }
      const emailField = await findFirst(page, selectors.login.emailInput, { timeout: 2500 });
      const passField = await findFirst(page, selectors.login.passwordInput, { timeout: 2000 });
      if (emailField && passField && email && password) {
        await emailField.fill(email);
        await passField.fill(password);
        const submit = await findFirst(page, selectors.login.submitButton, { timeout: 2000 });
        if (submit) await submit.click();
        else await passField.press('Enter');
        autoFilled = true;
        log('Submitted credentials — finishing up...', 'info');
      }
    }
  } catch {
    /* fall through to manual login */
  }

  if (!autoFilled && !googleUsed) {
    log('Please log in in the browser window — any sign-in method works.', 'warn');
  }

  // Wait for login to complete. Handles auto-fill, Google, fully-manual, and
  // Cloudflare (reloaded to nudge it through — but only on the community page,
  // never while you're on Google's domain). Generous window for manual steps.
  const host = (() => {
    try {
      return new URL(base).host;
    } catch {
      return '';
    }
  })();
  const waitMs = autoFilled ? 120000 : 180000; // 2 min auto, 3 min for Google/manual
  const deadline = Date.now() + waitMs;
  let ok = false;
  let lastReload = 0;
  let lastNudge = Date.now();
  let announcedCf = false;
  // The loop is cancellable: pressing Cancel sets stopRequested, freeing the
  // backend immediately instead of hanging for the whole window.
  //
  // It also never touches `page` for its own timing — closing that tab (easy to
  // do by hand mid-login) used to abort the whole attempt with "Target closed".
  while (Date.now() < deadline && !stopRequested) {
    if (await findLoggedInPage(ctx, host)) {
      ok = true;
      break;
    }
    const url = page.isClosed() ? '' : page.url();
    const onCommunity = host !== '' && url.includes(host);
    const title = page.isClosed() ? '' : await page.title().catch(() => '');
    if (onCommunity && /just a moment|verifying|attention required/i.test(title)) {
      if (!announcedCf) {
        log('Cloudflare human-check — solve it in the window, or just wait.', 'warn');
        announcedCf = true;
      }
      if (Date.now() - lastReload > 12000) {
        await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
        lastReload = Date.now();
        lastNudge = Date.now();
      }
    } else if (onCommunity && !/\/(sign_in|users\/sign_in|login)\b/i.test(url)) {
      // Sitting on a community page with no logged-in marker: the SPA can end up
      // rendering signed-out chrome after an OAuth round-trip until something
      // forces a fetch. One reload a minute unsticks that. Never while the
      // sign-in form is up — that would wipe what's being typed into it.
      if (Date.now() - lastNudge > 60000) {
        await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
        lastNudge = Date.now();
      }
    }
    await sleep(2000);
  }

  if (!ok) {
    if (stopRequested) throw new Error('Login cancelled.');
    throw new Error(
      headed
        ? 'Login was not completed in time. Sign in in the browser window, then try again.'
        : 'Login needs the browser window. Turn ON "Show browser window" and log in there.'
    );
  }

  // Cookies are persisted automatically by the on-disk profile — no extra save.
  log('Logged in. Session saved to the browser profile.', 'success');
  return true;
}

// ─── Send one message ────────────────────────────────────────────────────────

// Returns { outcome: 'sent' | 'skipped' | 'failed' | 'aborted', reason }.
async function sendOne({ profileUrl, message, log, rules }) {
  const page = await getPage();
  try {
    await page.goto(profileUrl.trim(), { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);

    // The "Message" button lives on the /u/ profile. No button → can't DM them.
    // This one gate decides whether the member is contacted at all, so it gets a
    // full action timeout rather than the 1.5s default — a profile that renders
    // its actions after an extra fetch is not a member without a Message button.
    const msgBtn = await findFirst(page, selectors.message.messageButton, {
      timeout: config.actionTimeoutMs,
    });
    if (!msgBtn) {
      // Skipping everyone is the failure mode of a stale selector, and "no
      // message button" alone gives nothing to fix it with. List what WAS
      // clickable so a label change is obvious from the log.
      const labels = await page
        .locator('button, a')
        .filter({ visible: true })
        .evaluateAll((els) =>
          [
            ...new Set(
              els
                .map((e) => (e.innerText || e.getAttribute('aria-label') || '').trim())
                .filter(Boolean)
            ),
          ].slice(0, 20)
        )
        .catch(() => []);
      log(`  no Message button. Visible controls: ${labels.join(' | ') || '(none)'}`, 'warn');
      return { outcome: 'skipped', reason: 'no message button' };
    }
    await msgBtn.click();

    // Clicking Message opens the /messages/<id> page with the composer.
    await page.waitForURL(/\/messages\//, { timeout: 15000 }).catch(() => {});
    const composer = await findFirst(page, selectors.message.composer, { timeout: 12000 });
    if (!composer) throw new Error('message composer not found');
    await page.waitForTimeout(1200); // let the conversation panel settle

    // Staff member? The role badge (e.g. ADMIN) is in the profile panel here.
    if (rules.skipModerators) {
      const role = await findFirst(page, selectors.message.moderatorMarkers, { timeout: 1500 });
      if (role) return { outcome: 'skipped', reason: 'staff/moderator' };
    }

    // Already messaged? A brand-new conversation shows "the beginning of your
    // direct message history". If that marker is ABSENT, there's prior history.
    if (rules.skipExistingConversation) {
      const isNew = await findFirst(page, selectors.message.newConversationMarker, {
        timeout: 2500,
      });
      if (!isNew) return { outcome: 'skipped', reason: 'already messaged' };
    }

    // Bail before sending if the user hit Stop while we were navigating.
    if (stopRequested) return { outcome: 'aborted', reason: 'stopped' };

    // Type the message into the rich-text composer. Two IAUG quirks handled:
    //  1) It's a tiptap/ProseMirror editor — fill() sets DOM text but doesn't
    //     fire the input events it needs, so Send stays disabled. insertText
    //     (real input) registers properly and enables Send.
    //  2) A plain newline acts as Enter = SEND, which splits a multi-line
    //     message into several messages. So we insert each line separately and
    //     use Shift+Enter for the line breaks, keeping it ONE message.
    await composer.click();
    const lines = String(message).split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) await page.keyboard.press('Shift+Enter');
      if (lines[i]) await page.keyboard.insertText(lines[i]);
    }
    await page.waitForTimeout(400);
    const typed = (await composer.innerText().catch(() => '')).trim();
    if (!typed) {
      for (let i = 0; i < lines.length; i++) {
        if (i > 0) await page.keyboard.press('Shift+Enter');
        if (lines[i]) await composer.pressSequentially(lines[i], { delay: 8 });
      }
      await page.waitForTimeout(400);
    }

    if (selectors.message.sendWithEnter) {
      await composer.press('Enter');
    } else {
      const sendBtn = await findFirst(page, selectors.message.sendButton, { timeout: 3000 });
      if (sendBtn) {
        try {
          await sendBtn.click({ timeout: 8000 });
        } catch {
          await composer.press('Enter');
        }
      } else {
        await composer.press('Enter');
      }
    }

    // Confirm the send actually happened: the composer clears once it posts.
    await page.waitForTimeout(1200);
    const leftover = (await composer.innerText().catch(() => '')).trim();
    if (leftover && leftover === message.trim()) {
      return { outcome: 'failed', reason: 'message did not send (still in box)' };
    }
    return { outcome: 'sent', reason: '' };
  } catch (err) {
    log(`  error: ${err.message}`, 'error');
    return { outcome: 'failed', reason: err.message };
  }
}

// ─── Public: run a whole send campaign ───────────────────────────────────────

export async function runCampaign(params, emit) {
  const { communityUrl, email, password, message, memberUrls, delay, showBrowser } = params;

  // Per-run skip rules: use the UI value when provided, else the config default.
  const pick = (v, fallback) => (typeof v === 'boolean' ? v : fallback);
  const rules = {
    skipAlreadySent: pick(params.skipAlreadySent, config.skipAlreadySent),
    skipExistingConversation: pick(params.skipExistingConversation, config.skipExistingConversation),
    skipModerators: pick(params.skipModerators, config.skipModerators),
  };

  const log = (message, type = 'info') => emit({ kind: 'log', message, type });
  stopRequested = false;
  paused = false;
  currentDelaySeconds = Number(delay) || 0; // live-adjustable from the UI

  const urls = String(memberUrls)
    .split('\n')
    .map((u) => u.trim())
    .filter(Boolean);

  if (urls.length === 0) {
    log('No member URLs provided.', 'warn');
    emit({ kind: 'status', status: 'idle' });
    return;
  }

  emit({ kind: 'status', status: 'running' });
  let sent = 0;
  let skipped = 0;
  let failed = 0;

  try {
    await login({ communityUrl, email, password, headed: showBrowser, log });
  } catch (err) {
    log(err.message, 'error');
    emit({ kind: 'status', status: 'stopped' });
    return;
  }

  // Load the "already-sent" history for this community + account.
  const historyFile = historyFileFor(normalizeBase(communityUrl), email);
  const history = loadHistory(historyFile);

  log(`Starting message sending to ${urls.length} members...`, 'info');
  emit({ kind: 'progress', index: 0, total: urls.length });

  // Record the run to history and emit the terminal status.
  const finalize = (st) => {
    recordCampaign({
      communityUrl: normalizeBase(communityUrl),
      total: urls.length,
      sent,
      skipped,
      failed,
      status: st,
      finishedAt: new Date().toISOString(),
    });
    emit({ kind: 'stats', sent, skipped, failed });
    emit({ kind: 'status', status: st });
    emit({ kind: 'historyUpdated' });
  };

  for (let i = 0; i < urls.length; i++) {
    if (stopRequested) {
      log('Sending stopped by user.', 'warn');
      finalize('stopped');
      return;
    }

    // Pause support: hold here while paused, without ending the run.
    if (paused) {
      log('Paused.', 'warn');
      emit({ kind: 'status', status: 'paused' });
      while (paused && !stopRequested) await sleep(500);
      if (stopRequested) {
        log('Sending stopped by user.', 'warn');
        finalize('stopped');
        return;
      }
      log('Resumed.', 'info');
      emit({ kind: 'status', status: 'running' });
    }

    const url = urls[i];
    const username = url.split('/u/')[1] || url;
    const canonical = normalizeProfileUrl(url);
    emit({ kind: 'progress', index: i + 1, total: urls.length });

    // Skip without opening the browser if we've messaged them in a past run.
    if (rules.skipAlreadySent && history.has(canonical)) {
      skipped++;
      log(`Skipped /u/${username} — already messaged (history)`, 'warn');
      emit({ kind: 'stats', sent, skipped, failed });
      continue;
    }

    const { outcome, reason } = await sendOne({ profileUrl: url, message, log, rules });
    if (outcome === 'aborted') {
      // Stop was pressed mid-member: don't count it, loop top will finalize.
      continue;
    } else if (outcome === 'sent') {
      sent++;
      history.add(canonical);
      saveHistory(historyFile, history);
      log(`Message sent to /u/${username}`, 'success');
    } else if (outcome === 'skipped') {
      skipped++;
      if (reason === 'already messaged') {
        history.add(canonical);
        saveHistory(historyFile, history);
      }
      log(`Skipped /u/${username} — ${reason}`, 'warn');
    } else {
      failed++;
      log(`Failed /u/${username}`, 'error');
    }
    emit({ kind: 'stats', sent, skipped, failed });

    // Delay between members. The target is recomputed every tick from the LIVE
    // delay value, so changing it in the UI (e.g. while paused) takes effect
    // immediately. Also reacts to Stop within ~200ms.
    if (i < urls.length - 1) {
      const sentAt = Date.now();
      while (!stopRequested) {
        const waitMs = Math.max(config.minDelaySeconds, currentDelaySeconds) * 1000;
        if (Date.now() - sentAt >= waitMs) break;
        await sleep(200);
      }
    }
  }

  log(`Done! Sent: ${sent}, Skipped: ${skipped}, Failed: ${failed}`, 'success');
  finalize('done');
}

// ─── Member harvesting (shared) ──────────────────────────────────────────────

async function harvestMembers(base, log, { maxScrolls = 200, stableLimit = 3, pageLimit = null } = {}) {
  const page = await getPage();
  const found = new Set();
  try {
    log('Opening member directory...');
    await page.goto(base + selectors.scrape.path, { waitUntil: 'domcontentloaded' });
    await sleep(1000);

    const limit = pageLimit ? Math.min(pageLimit, maxScrolls) : maxScrolls;
    let stable = 0;
    // One locator for the whole run — it re-queries on each use, so there's no
    // reason to rebuild it (and re-join the selector list) every round.
    const links = page.locator(selectors.scrape.profileLink.join(', '));

    for (let i = 0; i < limit; i++) {
      // Always harvest the members currently on screen FIRST, so a cancel never
      // loses what's already visible.
      const before = found.size;

      // Filter and de-dupe in the page instead of shipping every href across
      // the CDP boundary — on a big directory this is thousands of strings per
      // round, and the list only grows.
      const hrefs = await links.evaluateAll((els) => [
        ...new Set(
          els
            .map((e) => e.href.split(/[?#]/)[0])
            .filter((h) => /\/u\/[^/?#]+/.test(h))
        ),
      ]);
      for (const href of hrefs) found.add(href);

      if (found.size > before) {
        log(`  ${found.size} members found...`);
        stable = 0;
      } else if (pageLimit === null) {
        if (++stable >= stableLimit) break;
      }

      // Cancelled from the UI → stop now, keeping everything harvested above.
      if (stopRequested) {
        log(`Stopped — keeping ${found.size} members found so far.`);
        break;
      }

      // Trigger lazy-loading: bring the last profile into view, nudge the
      // window, and click any "Load more".
      const n = await links.count();
      if (n) await links.nth(n - 1).scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
      await page.mouse.wheel(0, 20000);
      const more = await findFirst(page, selectors.scrape.loadMoreButton, { timeout: 800 });
      if (more) await more.click().catch(() => {});
      await sleep(1500);
    }
  } catch (err) {
    log(`Scrape error: ${err.message}`);
  }
  return [...found];
}

// ─── Public: log in only (scraping is a separate, button-triggered step) ─────

export async function runLogin(params, emit) {
  const { communityUrl, email, password, showBrowser } = params;
  const log = (message) => emit({ kind: 'loginLog', message });
  const base = normalizeBase(communityUrl);
  stopRequested = false; // clear any leftover cancel from a previous attempt

  try {
    await login({ communityUrl: base, email, password, headed: showBrowser, log });
  } catch (err) {
    log(`Login failed: ${briefError(err)}`);
    emit({ kind: 'loginDone', ok: false });
    return;
  }

  log('Login successful.');
  emit({ kind: 'loginDone', ok: true });
}

// ─── Public: scrape member profile URLs ──────────────────────────────────────
// Reuses the saved login session. With no `pages` value it collects EVERY
// member (auto-scrolls until the list stops growing); a positive `pages` limits
// the number of scroll rounds.

export async function runScrape(params, emit) {
  const { communityUrl, email, password, pages, showBrowser } = params;
  const log = (message) => emit({ kind: 'scrapeLog', message });
  const base = normalizeBase(communityUrl);
  stopRequested = false; // clear any leftover stop from a previous run

  try {
    await login({ communityUrl: base, email, password, headed: showBrowser, log });
  } catch (err) {
    log(`Login failed: ${briefError(err)}`);
    emit({ kind: 'scrapeDone', urls: [] });
    return;
  }

  const pageLimit = Number(pages) > 0 ? Number(pages) : null; // null → all members
  const urls = await harvestMembers(base, log, { pageLimit });
  // Save the member list so it can be reused next time without re-scraping.
  if (urls.length) {
    saveMembersFor(base, urls);
    log(`Found ${urls.length} member URLs (saved for next time).`);
  } else {
    log('Found 0 member URLs.');
  }
  emit({ kind: 'scrapeDone', urls });
}
