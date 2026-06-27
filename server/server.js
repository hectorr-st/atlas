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
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// ─── Live event stream (SSE) ─────────────────────────────────────────────────
const clients = new Set();

app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write('\n');
  clients.add(res);
  req.on('close', () => clients.delete(res));
});

function emit(event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) res.write(payload);
}

// Only one automation run at a time.
let busy = false;

app.post('/api/login', async (req, res) => {
  if (busy) return res.status(409).json({ error: 'A run is already in progress.' });
  busy = true;
  res.json({ ok: true });
  try {
    await runLogin(req.body, emit);
  } catch (err) {
    emit({ kind: 'loginLog', message: `Fatal: ${err.message}` });
    emit({ kind: 'loginDone', ok: false });
  } finally {
    busy = false;
  }
});

app.post('/api/send', async (req, res) => {
  if (busy) return res.status(409).json({ error: 'A run is already in progress.' });
  busy = true;
  res.json({ ok: true });
  try {
    await runCampaign(req.body, emit);
  } catch (err) {
    emit({ kind: 'log', message: `Fatal: ${err.message}`, type: 'error' });
    emit({ kind: 'status', status: 'stopped' });
  } finally {
    busy = false;
  }
});

app.post('/api/scrape', async (req, res) => {
  if (busy) return res.status(409).json({ error: 'A run is already in progress.' });
  busy = true;
  res.json({ ok: true });
  try {
    await runScrape(req.body, emit);
  } catch (err) {
    emit({ kind: 'scrapeLog', message: `Fatal: ${err.message}` });
    emit({ kind: 'scrapeDone', urls: [] });
  } finally {
    busy = false;
  }
});

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
});

async function close() {
  await shutdown();
  server.close(() => process.exit(0));
}
process.on('SIGINT', close);
process.on('SIGTERM', close);
