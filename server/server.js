import express from 'express';
import cors from 'cors';
import { config } from './config.js';
import {
  runCampaign,
  runScrape,
  runLogin,
  requestStop,
  setPaused,
  setDelay,
  getCampaignHistory,
  getMembersFor,
  shutdown,
} from './automation.js';

const app = express();

// Any loopback origin is trusted: that is the person's own machine, and it is
// where `npm run dev` and a locally served build both come from.
const isLoopback = (origin) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin);

const configuredOrigins = [
  ...(config.allowedOrigins || []),
  ...(process.env.ATLAS_ALLOWED_ORIGINS || '').split(','),
]
  .map((o) => o.trim().replace(/\/+$/, ''))
  .filter(Boolean);

const warnedOrigins = new Set();

const isAllowedOrigin = (origin) =>
  isLoopback(origin) || configuredOrigins.includes(origin);

// An HTTPS page calling http://localhost is a PUBLIC page reaching into a
// PRIVATE address, so Chrome sends a Private Network Access preflight and drops
// the request unless the answer opts in. This has to run BEFORE cors(), which
// answers a preflight itself and never calls next() — a header set afterwards
// would never reach the wire. Granted only to origins the allow-list accepts.
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (req.headers['access-control-request-private-network'] && origin && isAllowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
  }
  next();
});

app.use(
  cors({
    origin(origin, callback) {
      // No Origin header at all — curl, EventSource polyfills, same-origin
      // navigations. Nothing to check, and blocking it breaks health checks.
      if (!origin) return callback(null, true);
      if (isAllowedOrigin(origin)) return callback(null, true);
      // Say so ONCE per origin. A silent CORS rejection is the single most
      // confusing way for a hosted frontend to fail — it looks like the backend
      // is down when it is actually running and refusing to answer.
      if (!warnedOrigins.has(origin)) {
        warnedOrigins.add(origin);
        console.warn(
          `Blocked request from ${origin}. Add it to allowedOrigins in ` +
            'server/config.js, or set ATLAS_ALLOWED_ORIGINS.'
        );
      }
      return callback(null, false);
    },
  })
);

app.use(express.json({ limit: '1mb' }));

// ─── Live event stream (SSE) ─────────────────────────────────────────────────
const clients = new Set();

app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  // A run can sit silent for minutes (waiting on the delay, or on a manual
  // login), so disable the socket idle timeout and flush each event as it is
  // written rather than letting Nagle batch it.
  res.socket?.setTimeout(0);
  res.socket?.setNoDelay(true);
  res.write('\n');
  clients.add(res);
  req.on('close', () => clients.delete(res));
});

// Comment-only heartbeat keeps intermediaries from dropping an idle stream.
const heartbeat = setInterval(() => {
  for (const res of clients) res.write(': ping\n\n');
}, 25000);
heartbeat.unref();

function emit(event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) {
    // A client that vanished without a 'close' event (killed tab, dropped
    // network) would otherwise throw on every subsequent emit.
    if (res.writableEnded || res.destroyed) {
      clients.delete(res);
      continue;
    }
    res.write(payload);
  }
}

// Only one automation run at a time. The route acknowledges immediately and the
// run reports itself over SSE, so `onError` is how a crash reaches the UI.
let busy = false;

function runEndpoint(run, onError) {
  return async (req, res) => {
    if (busy) return res.status(409).json({ error: 'A run is already in progress.' });
    busy = true;
    res.json({ ok: true });
    try {
      await run(req.body, emit);
    } catch (err) {
      onError(err);
    } finally {
      busy = false;
    }
  };
}

app.post(
  '/api/login',
  runEndpoint(runLogin, (err) => {
    emit({ kind: 'loginLog', message: `Fatal: ${err.message}` });
    emit({ kind: 'loginDone', ok: false });
  })
);

app.post(
  '/api/send',
  runEndpoint(runCampaign, (err) => {
    emit({ kind: 'log', message: `Fatal: ${err.message}`, type: 'error' });
    emit({ kind: 'status', status: 'stopped' });
  })
);

app.post(
  '/api/scrape',
  runEndpoint(runScrape, (err) => {
    emit({ kind: 'scrapeLog', message: `Fatal: ${err.message}` });
    emit({ kind: 'scrapeDone', urls: [] });
  })
);

app.post('/api/stop', (req, res) => {
  requestStop();
  res.json({ ok: true });
});

app.post('/api/pause', (req, res) => {
  setPaused(true);
  res.json({ ok: true });
});

app.post('/api/resume', (req, res) => {
  setPaused(false);
  res.json({ ok: true });
});

// Live-adjust the per-message delay (seconds) during a run.
app.post('/api/delay', (req, res) => {
  setDelay(req.body?.delay);
  res.json({ ok: true });
});

app.get('/api/history', (req, res) => res.json({ communities: getCampaignHistory() }));

// Saved member list for a community (so the UI can reuse it without re-scraping).
app.get('/api/members', (req, res) => res.json(getMembersFor(req.query.community || '')));

app.get('/api/health', (req, res) => res.json({ ok: true, busy }));

const server = app.listen(config.port, () => {
  console.log(`Circle DM Bot backend listening on http://localhost:${config.port}`);
  if (configuredOrigins.length) {
    console.log(`Also accepting requests from: ${configuredOrigins.join(', ')}`);
  }
});

let closing = false;
async function close() {
  if (closing) process.exit(0); // second Ctrl+C → go now
  closing = true;
  clearInterval(heartbeat);
  // server.close() waits for open connections, and an SSE stream never ends on
  // its own — without this, Ctrl+C hung forever with the UI open.
  for (const res of clients) res.end();
  clients.clear();
  server.close(() => process.exit(0));
  await shutdown();
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGINT', close);
process.on('SIGTERM', close);
