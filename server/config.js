// ─────────────────────────────────────────────────────────────────────────────
//  SELECTORS — the part you tweak to match a specific Circle.so community.
//  Each entry is a LIST of candidate selectors tried in order, so you can add a
//  verified selector to the front and keep the defaults as fallbacks.
// ─────────────────────────────────────────────────────────────────────────────

export const selectors = {
  // ---- Login page ----
  login: {
    // URL path appended to the community URL to reach the sign-in form.
    path: '/sign_in',
    // "Sign in with Google" button on the community sign-in page. Preferred when
    // present — clicking it opens Google's sign-in, which we pre-fill with your
    // email; you finish with your Google password / 2FA in the window.
    googleButton: [
      'button:has-text("Sign in with Google")',
      'button:has-text("Continue with Google")',
      'a:has-text("Sign in with Google")',
      'a:has-text("Continue with Google")',
      'button:has-text("Google")',
      'a:has-text("Google")',
      '[aria-label*="Google" i]',
    ],
    // Some communities hide the form behind a "Sign in with an email" button.
    emailFirstButton: [
      'button:has-text("Sign in with an email")',
      'a:has-text("Sign in with an email")',
      'button:has-text("Sign in with email")',
    ],
    emailInput: [
      'input[name="user[email]"]',
      '#user_email',
      'input[type="email"]',
      'input[name="email"]',
      '#email',
    ],
    passwordInput: [
      'input[name="user[password]"]',
      '#user_password',
      'input[type="password"]',
      'input[name="password"]',
      '#password',
    ],
    submitButton: [
      'button:has-text("Sign In")',
      'button[type="submit"]',
      'input[type="submit"]',
      'button:has-text("Log in")',
    ],
    // Elements that only exist once logged in. Kept generic so login detection
    // works across different Circle communities (not just one). These are all
    // authenticated-only affordances in Circle's top nav.
    loggedInMarker: [
      '[aria-label*="user menu" i]',
      '[aria-label*="direct messages" i]',
      '[aria-label="Notifications"]',
      'button:has-text("New post")',
      'a[href*="/messages"]',
      'a[href*="/settings"]',
      'img[alt*="avatar" i]',
      '[class*="user-menu" i]',
    ],
  },

  // ---- Member profile → direct message ----
  // Flow on Circle/IAUG: a member's /u/ profile has a "Message" button. Clicking
  // it opens the full /messages/<id> page with a left inbox sidebar, the active
  // conversation in the middle, and the member's profile panel on the right.
  message: {
    messageButton: [
      'button:has-text("Message")',
      'a:has-text("Message")',
      'button:has-text("Send message")',
    ],
    // The text box you type the DM into (a tiptap/ProseMirror rich editor).
    composer: [
      'div[contenteditable="true"].ProseMirror',
      'div.tiptap[contenteditable="true"]',
      'div[contenteditable="true"]',
      'textarea',
    ],
    // The send control next to the composer.
    sendButton: [
      'button[aria-label="Send message"]',
      'button[aria-label*="send" i]',
      'button:has-text("Send")',
    ],
    // If true, press Enter to send instead of clicking sendButton.
    sendWithEnter: false,
    // Shown ONLY at the top of a brand-new conversation you've never messaged:
    // "This is the very beginning of your direct message history with ...".
    // Its PRESENCE = not messaged yet (safe to send). Its ABSENCE = there's
    // already history → treat as already messaged. Scoped to the active thread,
    // so it does NOT false-match the inbox sidebar.
    newConversationMarker: [
      'text=/beginning of your direct message history/i',
    ],
    // Role badge in the member's profile panel on the messages page. Matched as
    // exact badge text so it only flags the person you're viewing.
    moderatorMarkers: [
      'text=/^\\s*(admin|moderator|community manager|owner|staff)\\s*$/i',
    ],
  },

  // ---- Member directory (for the scraper) ----
  scrape: {
    path: '/members',
    // Anchors that point at member profiles, matched against the /u/<id> pattern.
    profileLink: ['a[href*="/u/"]'],
    // Optional "Load more"/"Show more" button some directories use.
    loadMoreButton: [
      'button:has-text("Load more")',
      'button:has-text("Show more")',
      'button:has-text("See more")',
    ],
  },
};

export const config = {
  port: 3001,

  // ---- Who may call this backend ----
  // The API can send DMs as you and has no login of its own, so the browser's
  // same-origin rules are the ONLY thing standing between it and any page you
  // happen to have open. With CORS wide open, any website you visited could
  // POST to http://localhost:3001/api/send. So origins are allow-listed.
  //
  // Every http://localhost / 127.0.0.1 port is allowed automatically (that
  // covers `npm run dev` and a locally served build). Add the origin of your
  // HOSTED frontend here — scheme + host, no trailing slash:
  // Vercel also gives every deployment its own preview URL; add those here too
  // (or via the env var) if you want to use one.
  allowedOrigins: ['https://atlas-aoicom.vercel.app'],
  // Use your real installed browser instead of Playwright's bundled Chromium —
  // this passes Cloudflare's human-check far more often. Options: 'chrome',
  // 'msedge', or '' / null to use the bundled Chromium.
  browserChannel: 'chrome',
  // Where the persistent browser profile + history files are stored.
  sessionDir: '.session',

  // ---- Which Chrome the automation drives ----
  // ON: attach to a Chrome that is ALREADY OPEN, over the DevTools protocol, and
  // run in a NEW TAB of it. That window is not Playwright's to own, so it stays
  // open between runs and survives restarting this backend.
  //
  // Chrome only exposes that port when it was started with
  // `--remote-debugging-port`, and since Chrome 136 it REFUSES to do so for the
  // DEFAULT user-data-dir — so an everyday Chrome window cannot be attached to
  // as-is. To drive a Chrome you start yourself, launch it with BOTH flags:
  //   chrome.exe --remote-debugging-port=9222 --user-data-dir="%LOCALAPPDATA%\AtlasChrome"
  // Atlas attaches to whatever answers on the port. If nothing does, it opens
  // Chrome that way itself using the profile below — log in once there, and
  // every later run just adds a tab to that same window.
  //
  // OFF: fall back to launching a browser Playwright owns, and closes with it.
  attachToChrome: true,
  debugPort: 9222,
  // Chrome executable. Empty → auto-detect the installed one.
  chromePath: '',
  // Profile dir for a Chrome we start ourselves. Empty → the profile inside
  // sessionDir. Must NOT be Chrome's default user-data dir: Chrome disables
  // remote debugging there, so the port would never open.
  chromeUserDataDir: '',
  // Hard floor on per-message delay regardless of UI, to keep things human-ish.
  minDelaySeconds: 2,
  // Per-action timeout (ms) when waiting for a selector.
  actionTimeoutMs: 15000,

  // ---- Skip rules (UI toggles override these per run) ----
  skipAlreadySent: true,
  skipExistingConversation: true,
  skipModerators: true,
};
