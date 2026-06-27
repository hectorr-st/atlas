import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { selectors, config } from './config.js';

// ─── Shared browser state ────────────────────────────────────────────────────
// We use a PERSISTENT browser profile (a real on-disk Chrome user-data dir).
// This keeps the Cloudflare "clearance" cookie and the Circle login between
// runs, so the human-check stops reappearing after you pass it once.
let context = null;

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
async function findFirst(scope, candidates, { timeout = 1500 } = {}) {
  for (const sel of candidates) {
    const loc = scope.locator(sel).first();
    try {
      await loc.waitFor({ state: 'visible', timeout });
      return loc;
    } catch {
      // try next candidate
    }
  }
  return null;
}

function normalizeBase(url) {
  return url.trim().replace(/\/+$/, '');
}

// Canonical form of a profile URL for history comparison (drop query/hash/slash).
function normalizeProfileUrl(url) {
  return url.trim().split(/[?#]/)[0].replace(/\/+$/, '');
}

// ─── "Already-sent" history (persisted per community+account) ────────────────

function historyFileFor(communityUrl, email) {
  const key = crypto
    .createHash('sha256')
    .update(`${communityUrl}::${email}`)
    .digest('hex')
    .slice(0, 16);
  const dir = path.resolve(process.cwd(), config.sessionDir);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `sent-${key}.json`);
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
  const dir = path.resolve(process.cwd(), config.sessionDir);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'campaigns.json');
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
  for (const r of loadCampaigns()) {
    const key = r.communityUrl;
    const agg = byCommunity.get(key) || {
      communityUrl: key,
      runs: 0,
      totalMembers: 0,
      processed: 0,
      sent: 0,
      skipped: 0,
      failed: 0,
      lastRun: null,
    };
    agg.runs += 1;
    agg.totalMembers += r.total || 0;
    agg.processed += (r.sent || 0) + (r.skipped || 0) + (r.failed || 0);
    agg.sent += r.sent || 0;
    agg.skipped += r.skipped || 0;
    agg.failed += r.failed || 0;
    if (!agg.lastRun || r.finishedAt > agg.lastRun) agg.lastRun = r.finishedAt;
    byCommunity.set(key, agg);
  }
  // Merge in communities that have been SCRAPED (member lists saved), even if
  // no send campaign has run for them yet.
  const store = loadMembersStore();
  for (const [url, data] of Object.entries(store)) {
    const agg = byCommunity.get(url) || {
      communityUrl: url,
      runs: 0,
      totalMembers: 0,
      processed: 0,
      sent: 0,
      skipped: 0,
      failed: 0,
      lastRun: null,
    };
    agg.scrapedMembers = (data.urls || []).length;
    if (data.scrapedAt && (!agg.lastRun || data.scrapedAt > agg.lastRun)) {
      agg.lastRun = data.scrapedAt;
    }
    byCommunity.set(url, agg);
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
  const dir = path.resolve(process.cwd(), config.sessionDir);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'members.json');
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

async function ensureContext({ headed, log }) {
  if (context) return context;

  const profileDir = path.resolve(process.cwd(), config.sessionDir, 'profile');
  fs.mkdirSync(profileDir, { recursive: true });
  const hadProfile = fs.existsSync(path.join(profileDir, 'Default'));

  log(`Launching browser (${headed ? 'visible' : 'headless'})...`, 'info');
  try {
    context = await chromium.launchPersistentContext(profileDir, {
      headless: !headed,
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
    context = null;
    if (headed && /display|x11|cannot open/i.test(err.message)) {
      throw new Error(
        'Cannot open a visible browser — no graphical display found. Run the backend ' +
          'from your desktop (a terminal inside your logged-in session), not over SSH/headless. ' +
          'Or turn OFF "Show browser window" to run headless (only works once a session is saved).'
      );
    }
    throw err;
  }

  // If the window/context is closed (user closes it, or Chrome crashes), drop
  // the stale singleton so the next attempt relaunches cleanly.
  context.once('close', () => {
    context = null;
  });

  context.setDefaultTimeout(config.actionTimeoutMs);
  // Hide the navigator.webdriver flag that automated Chromium exposes.
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  if (hadProfile) log('Reusing saved browser profile (login + Cloudflare clearance).', 'info');
  return context;
}

export async function shutdown() {
  try {
    await context?.close();
  } catch {
    /* ignore */
  }
  context = null;
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

async function login({ communityUrl, email, password, headed, log, loginMethod }) {
  const base = normalizeBase(communityUrl);
  const ctx = await ensureContext({ headed, log });
  const page = await ctx.newPage();

  // If the saved session is still valid, skip the login form entirely.
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3500); // let the SPA render before checking markers
  if (await isLoggedIn(page)) {
    log('Already logged in.', 'success');
    await page.close();
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
  const wantGoogle = loginMethod !== 'password';
  try {
    const googleBtn = wantGoogle
      ? await findFirst(page, selectors.login.googleButton, { timeout: 3000 })
      : null;
    if (loginMethod === 'google' && !googleBtn) {
      log('No "Sign in with Google" button found — log in manually in the window.', 'warn');
    }
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
  let announcedCf = false;
  // The loop is cancellable: pressing Cancel sets stopRequested, freeing the
  // backend immediately instead of hanging for the whole window.
  while (Date.now() < deadline && !stopRequested) {
    if (await isLoggedIn(page)) {
      ok = true;
      break;
    }
    const onCommunity = page.url().includes(host);
    const title = await page.title().catch(() => '');
    if (onCommunity && /just a moment|verifying|attention required/i.test(title)) {
      if (!announcedCf) {
        log('Cloudflare human-check — solve it in the window, or just wait.', 'warn');
        announcedCf = true;
      }
      if (Date.now() - lastReload > 12000) {
        await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
        lastReload = Date.now();
      }
    }
    await page.waitForTimeout(2000);
  }

  if (!ok) {
    await page.close();
    if (stopRequested) throw new Error('Login cancelled.');
    throw new Error(
      headed
        ? 'Login was not completed in time. Sign in in the browser window, then try again.'
        : 'Login needs the browser window. Turn ON "Show browser window" and log in there.'
    );
  }

  // Cookies are persisted automatically by the on-disk profile — no extra save.
  log('Logged in. Session saved to the browser profile.', 'success');
  await page.close();
  return true;
}

// ─── Send one message ────────────────────────────────────────────────────────

// Returns { outcome: 'sent' | 'skipped' | 'failed' | 'aborted', reason }.
async function sendOne({ profileUrl, message, log, rules }) {
  const page = await context.newPage();
  try {
    await page.goto(profileUrl.trim(), { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);

    // The "Message" button lives on the /u/ profile. No button → can't DM them.
    const msgBtn = await findFirst(page, selectors.message.messageButton);
    if (!msgBtn) {
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
  } finally {
    await page.close().catch(() => {});
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
  const page = await context.newPage();
  const found = new Set();
  try {
    log('Opening member directory...');
    await page.goto(base + selectors.scrape.path, { waitUntil: 'domcontentloaded' });
    await sleep(1000);

    const limit = pageLimit ? Math.min(pageLimit, maxScrolls) : maxScrolls;
    let stable = 0;

    for (let i = 0; i < limit; i++) {
      // Always harvest the members currently on screen FIRST, so a cancel never
      // loses what's already visible.
      const before = found.size;

      const hrefs = await page
        .locator(selectors.scrape.profileLink.join(', '))
        .evaluateAll((els) => els.map((e) => e.href));
      for (const href of hrefs) {
        if (/\/u\/[^/?#]+/.test(href)) found.add(href.split(/[?#]/)[0]);
      }

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
      const links = page.locator(selectors.scrape.profileLink.join(', '));
      const n = await links.count();
      if (n) await links.nth(n - 1).scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
      await page.mouse.wheel(0, 20000);
      const more = await findFirst(page, selectors.scrape.loadMoreButton, { timeout: 800 });
      if (more) await more.click().catch(() => {});
      await sleep(1500);
    }
  } catch (err) {
    log(`Scrape error: ${err.message}`);
  } finally {
    await page.close().catch(() => {});
  }
  return [...found];
}

// ─── Public: log in only (scraping is a separate, button-triggered step) ─────

export async function runLogin(params, emit) {
  const { communityUrl, email, password, showBrowser, loginMethod } = params;
  const log = (message) => emit({ kind: 'loginLog', message });
  const base = normalizeBase(communityUrl);
  stopRequested = false; // clear any leftover cancel from a previous attempt

  try {
    await login({ communityUrl: base, email, password, headed: showBrowser, log, loginMethod });
  } catch (err) {
    log(`Login failed: ${err.message}`);
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
    log(`Login failed: ${err.message}`);
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
