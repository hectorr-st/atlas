import { useState, useEffect, useRef, useMemo, memo } from 'react';
import { Lock, Send, Square, Search, Bot, X, Trash2, Pause, Play, History, Users, MessageSquare, Link as LinkIcon } from 'lucide-react';

type Status = 'idle' | 'running' | 'paused' | 'done' | 'stopped';
type LogType = 'info' | 'success' | 'warn' | 'error';

interface LogEntry {
  id: number;
  timestamp: string;
  message: string;
  type: LogType;
}

interface CommunityStat {
  communityUrl: string;
  runs: number;
  totalMembers: number;
  processed: number;
  sent: number;
  skipped: number;
  failed: number;
  completionRate: number;
  scrapedMembers: number;
  lastRun: string | null;
}

// Base URL of the Playwright backend (see /server). The backend always runs on
// the machine the person is sitting at — even when this UI is served from a
// static host — so localhost is the right default. VITE_API_URL overrides it at
// BUILD time for anyone running the backend on a different port or host.
const API = (import.meta.env.VITE_API_URL || 'http://localhost:3001').replace(/\/+$/, '');

const pct = (part: number, total: number) => (total ? (part / total) * 100 : 0);

// Cap on the rendered log list. A campaign can emit thousands of lines, and
// every one of them re-renders the whole panel; past a few hundred rows the
// scroll container is the slowest thing on the page. The authoritative totals
// live in the stat tiles, not here.
const MAX_LOGS = 500;

// The three charts are pure functions of their numeric props, but they sit in a
// component that re-renders on every streamed log line. memo() keeps their SVG
// path math off that path.

// A progress ring showing how much of the scraped list has been PROCESSED
// (sent + skipped + failed) out of the total scraped members.
const ProgressRing = memo(({ value, total }: { value: number; total: number }) => {
  const ratio = total > 0 ? value / total : 0;
  const r = 42;
  const c = 2 * Math.PI * r;
  const len = ratio * c;
  return (
    <div className="relative w-28 h-28 flex-shrink-0">
      <svg viewBox="0 0 100 100" className="w-28 h-28 -rotate-90">
        <circle cx="50" cy="50" r={r} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth={13} />
        <circle
          cx="50"
          cy="50"
          r={r}
          fill="none"
          stroke="#22c55e"
          strokeWidth={13}
          strokeDasharray={`${len} ${c - len}`}
          strokeLinecap="round"
          style={{ transition: 'stroke-dasharray 0.4s ease' }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-2xl font-mono font-semibold text-text">{Math.round(ratio * 100)}%</span>
        <span className="text-[10px] uppercase text-muted">processed</span>
      </div>
    </div>
  );
});

// A real-time line chart of sending speed (messages per minute over time).
const SpeedChart = memo(({ series }: { series: number[] }) => {
  const w = 260;
  const h = 64;
  const pad = 4;
  const max = Math.max(1, ...series);
  const n = series.length;
  const pts = series.map((v, i) => {
    const x = n <= 1 ? pad : pad + (i / (n - 1)) * (w - 2 * pad);
    const y = h - pad - (v / max) * (h - 2 * pad);
    return [x, y] as const;
  });
  const line = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  const area = pts.length
    ? `${line} L${pts[n - 1][0].toFixed(1)},${h - pad} L${pts[0][0].toFixed(1)},${h - pad} Z`
    : '';
  const current = series.length ? series[series.length - 1] : 0;
  return (
    <div className="bg-surface rounded-[8px] p-4 border border-border">
      <div className="flex items-baseline justify-between mb-1">
        <span className="text-xs uppercase text-muted font-medium">Sending speed</span>
        <span className="text-sm font-mono text-text">
          {current} <span className="text-muted text-xs">msg/min</span>
        </span>
      </div>
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-16" preserveAspectRatio="none">
        {area && <path d={area} fill="rgba(34,197,94,0.12)" />}
        {line && (
          <path d={line} fill="none" stroke="#22c55e" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
        )}
      </svg>
    </div>
  );
});

const DonutChart = memo(({ sent, skipped, failed }: { sent: number; skipped: number; failed: number }) => {
  const total = sent + skipped + failed;
  const r = 42;
  const c = 2 * Math.PI * r;
  const segments = [
    { v: sent, color: '#22c55e' },
    { v: skipped, color: '#f59e0b' },
    { v: failed, color: '#ef4444' },
  ];
  let offset = 0;
  return (
    <div className="relative w-28 h-28 flex-shrink-0">
      <svg viewBox="0 0 100 100" className="w-28 h-28 -rotate-90">
        <circle cx="50" cy="50" r={r} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth={13} />
        {total > 0 &&
          segments.map((s, i) => {
            const len = (s.v / total) * c;
            const el = (
              <circle
                key={i}
                cx="50"
                cy="50"
                r={r}
                fill="none"
                stroke={s.color}
                strokeWidth={13}
                strokeDasharray={`${len} ${c - len}`}
                strokeDashoffset={-offset}
                strokeLinecap="butt"
              />
            );
            offset += len;
            return el;
          })}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-2xl font-mono font-semibold text-text">{total}</span>
        <span className="text-[10px] uppercase text-muted">processed</span>
      </div>
    </div>
  );
});

const getStatusColor = (status: Status) => {
  switch (status) {
    case 'idle':
      return 'bg-muted';
    case 'running':
      return 'bg-warning';
    case 'paused':
      return 'bg-muted';
    case 'done':
      return 'bg-success';
    case 'stopped':
      return 'bg-error';
  }
};

const getStatusText = (status: Status) => {
  switch (status) {
    case 'idle':
      return 'Idle';
    case 'running':
      return 'Running';
    case 'paused':
      return 'Paused';
    case 'done':
      return 'Done';
    case 'stopped':
      return 'Stopped';
  }
};

const getLogRowStyle = (type: LogType) => {
  switch (type) {
    case 'success':
      return 'bg-success/5 border-l-2 border-success';
    case 'warn':
      return 'bg-warning/5 border-l-2 border-warning';
    case 'error':
      return 'bg-error/5 border-l-2 border-error';
    default:
      return '';
  }
};

const getLogTextStyle = (type: LogType) => {
  switch (type) {
    case 'success':
      return 'text-success';
    case 'warn':
      return 'text-warning';
    case 'error':
      return 'text-error';
    default:
      return 'text-text';
  }
};

interface ToggleProps {
  label: string;
  description: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}

const Toggle = memo(({ label, description, checked, onChange }: ToggleProps) => (
  <div className="flex items-center justify-between">
    <div className="pr-3">
      <label className="block text-sm text-text">{label}</label>
      <p className="text-xs text-muted">{description}</p>
    </div>
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`w-12 h-6 rounded-full transition-colors flex-shrink-0 ${
        checked ? 'bg-accent' : 'bg-surface-2'
      }`}
    >
      <div
        className={`w-5 h-5 rounded-full bg-white transition-transform ${
          checked ? 'translate-x-6' : 'translate-x-0.5'
        }`}
      />
    </button>
  </div>
));

function App() {
  const [view, setView] = useState<'login' | 'app'>('login');
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [loginLogs, setLoginLogs] = useState<string[]>([]);
  const [status, setStatus] = useState<Status>('idle');
  const [communityUrl, setCommunityUrl] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState('');
  const [memberUrls, setMemberUrls] = useState('');
  const [delay, setDelay] = useState(0);
  const [concurrency, setConcurrency] = useState(3);
  const [showBrowser, setShowBrowser] = useState(true);
  const [skipAlreadySent, setSkipAlreadySent] = useState(true);
  const [skipExistingConversation, setSkipExistingConversation] = useState(true);
  const [skipModerators, setSkipModerators] = useState(true);
  const [sentCount, setSentCount] = useState(0);
  const [skippedCount, setSkippedCount] = useState(0);
  const [failedCount, setFailedCount] = useState(0);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [totalMembers, setTotalMembers] = useState(0);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isScraping, setIsScraping] = useState(false);
  const [scrapeLogs, setScrapeLogs] = useState<string[]>([]);
  const [scrapedUrls, setScrapedUrls] = useState<string[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [showCommunities, setShowCommunities] = useState(false);
  const [showMessageBox, setShowMessageBox] = useState(false);
  const [showMemberBox, setShowMemberBox] = useState(false);
  const [communities, setCommunities] = useState<CommunityStat[]>([]);
  const [showFinished, setShowFinished] = useState(false);
  const [speedSeries, setSpeedSeries] = useState<number[]>([]);

  const logEndRef = useRef<HTMLDivElement>(null);
  const logIdRef = useRef(0);
  const sentTimesRef = useRef<number[]>([]); // timestamps of each sent message
  const lastSentRef = useRef(0); // last seen sent count, to detect new sends
  const communityUrlRef = useRef(''); // current community URL (for SSE closures)
  useEffect(() => {
    communityUrlRef.current = communityUrl;
  }, [communityUrl]);

  // memberUrls can hold thousands of lines, and this component re-renders on
  // every streamed log line — so don't re-split the whole list each time.
  const memberList = useMemo(
    () => memberUrls.split('\n').map((u) => u.trim()).filter(Boolean),
    [memberUrls]
  );
  const memberCount = memberList.length;

  const charCount = message.length;

  // Credentials are validated at the login screen; the main form just needs a
  // message and at least one member URL.
  const isFormValid = message.trim() !== '' && memberUrls.trim() !== '';

  // Only the community URL is required — you can log in by hand in the browser
  // window, so email/password are optional (used only for best-effort auto-fill).
  const isLoginValid = communityUrl.trim() !== '';

  const isRunning = status === 'running';
  const isPaused = status === 'paused';
  // The campaign is "active" while running OR paused (paused isn't finished).
  const isActive = isRunning || isPaused;

  const getTimestamp = () => {
    const now = new Date();
    return now.toTimeString().split(' ')[0];
  };

  const addLog = (message: string, type: LogType = 'info') => {
    const entry = { id: logIdRef.current++, timestamp: getTimestamp(), message, type };
    setLogs((prev) =>
      prev.length >= MAX_LOGS ? [...prev.slice(prev.length - MAX_LOGS + 1), entry] : [...prev, entry]
    );
  };

  const clearLogs = () => {
    setLogs([]);
    setSentCount(0);
    setSkippedCount(0);
    setFailedCount(0);
    setCurrentIndex(0);
    setTotalMembers(0);
  };

  const handleLogin = async () => {
    if (!isLoginValid || isLoggingIn) return;
    setIsLoggingIn(true);
    setLoginLogs(['Connecting to community...']);
    try {
      const res = await fetch(`${API}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ communityUrl, email, password, showBrowser }),
      });
      if (!res.ok) {
        const { error } = await res.json().catch(() => ({ error: res.statusText }));
        setLoginLogs((prev) => [...prev, `Could not start: ${error}`]);
        setIsLoggingIn(false);
      }
      // loginLog / loginDone events arrive over the SSE stream.
    } catch {
      setLoginLogs((prev) => [...prev, 'Backend not reachable. Is the server running? (cd server && npm start)']);
      setIsLoggingIn(false);
    }
  };

  const cancelLogin = async () => {
    setLoginLogs((prev) => [...prev, 'Cancelling...']);
    await fetch(`${API}/api/stop`, { method: 'POST' }).catch(() => {});
    // Deliberately leave `isLoggingIn` set. The backend needs a few seconds to
    // unwind the poll loop and always emits `loginDone`, which clears it.
    // Clearing it here re-enabled the button while the server was still busy,
    // so the very next click came back 409 "A run is already in progress".
  };

  const handleLogout = () => {
    setView('login');
    setIsLoggingIn(false);
    setLoginLogs([]);
    setMemberUrls('');
    setStatus('idle');
    setLogs([]);
  };

  const startSending = async () => {
    const urls = memberList;
    if (urls.length === 0) return;

    setStatus('running');
    setTotalMembers(urls.length);
    setCurrentIndex(0);
    setSentCount(0);
    setSkippedCount(0);
    setFailedCount(0);
    setLogs([]);
    // Reset speed tracking for the new campaign.
    sentTimesRef.current = [];
    lastSentRef.current = 0;
    setSpeedSeries([]);

    try {
      const res = await fetch(`${API}/api/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          communityUrl,
          email,
          password,
          message,
          memberUrls,
          delay,
          concurrency,
          showBrowser,
          skipAlreadySent,
          skipExistingConversation,
          skipModerators,
        }),
      });
      if (!res.ok) {
        const { error } = await res.json().catch(() => ({ error: res.statusText }));
        setStatus('stopped');
        addLog(`Could not start: ${error}`, 'error');
      }
      // Progress, logs, stats, and final status all arrive over the SSE stream.
    } catch {
      setStatus('stopped');
      addLog('Backend not reachable. Is the server running? (cd server && npm start)', 'error');
    }
  };

  const stopSending = async () => {
    addLog('Stopping after the current member...', 'warn');
    await fetch(`${API}/api/stop`, { method: 'POST' }).catch(() => {});
  };

  // Pause/resume the run without ending it. Backend confirms via SSE status.
  const togglePause = async () => {
    if (isPaused) {
      setStatus('running');
      await fetch(`${API}/api/resume`, { method: 'POST' }).catch(() => {});
    } else {
      setStatus('paused');
      await fetch(`${API}/api/pause`, { method: 'POST' }).catch(() => {});
    }
  };

  const startScraping = async () => {
    if (!communityUrl.trim()) {
      setScrapeLogs(['Enter the community URL first.']);
      return;
    }

    setIsScraping(true);
    setScrapeLogs(['Starting scraper — collecting all members...']);
    setScrapedUrls([]);

    try {
      const res = await fetch(`${API}/api/scrape`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // No `pages` → backend collects every member.
        body: JSON.stringify({ communityUrl, email, password, showBrowser }),
      });
      if (!res.ok) {
        const { error } = await res.json().catch(() => ({ error: res.statusText }));
        setScrapeLogs((prev) => [...prev, `Could not start: ${error}`]);
        setIsScraping(false);
      }
      // Progress and results arrive over the SSE stream (see the events effect).
    } catch {
      setScrapeLogs((prev) => [...prev, 'Backend not reachable. Is the server running?']);
      setIsScraping(false);
    }
  };

  // Stop scraping but KEEP what was collected so far. The backend finishes the
  // current loop and emits scrapeDone with the partial list, which lands in
  // scrapedUrls so it can be added to the member list.
  const stopScraping = async () => {
    setScrapeLogs((prev) => [...prev, 'Stopping — keeping members found so far...']);
    await fetch(`${API}/api/stop`, { method: 'POST' }).catch(() => {});
  };

  const addToMemberList = () => {
    const existing = memberUrls.trim();
    const newUrls = scrapedUrls.join('\n');
    setMemberUrls(existing ? `${existing}\n${newUrls}` : newUrls);
    setIsModalOpen(false);
    setScrapedUrls([]);
    setScrapeLogs([]);
  };

  const closeModal = () => {
    // If a scrape is still running, stop it so it doesn't keep going in the
    // background after the modal is closed.
    if (isScraping) fetch(`${API}/api/stop`, { method: 'POST' }).catch(() => {});
    setIsScraping(false);
    setIsModalOpen(false);
    setScrapedUrls([]);
    setScrapeLogs([]);
  };

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  const fetchHistory = () => {
    fetch(`${API}/api/history`)
      .then((r) => r.json())
      .then((d) => setCommunities(d.communities || []))
      .catch(() => {});
  };

  // Load a community's previously-scraped member list into the member box.
  // Returns the number of members loaded (0 if none saved).
  const loadSavedMembers = async (community: string): Promise<number> => {
    try {
      const res = await fetch(`${API}/api/members?community=${encodeURIComponent(community)}`);
      const data = await res.json();
      const urls: string[] = data.urls || [];
      if (urls.length) setMemberUrls(urls.join('\n'));
      return urls.length;
    } catch {
      return 0;
    }
  };

  // Load past-campaign history once on mount.
  useEffect(fetchHistory, []);

  // Subscribe once to the backend's live event stream.
  useEffect(() => {
    const source = new EventSource(`${API}/api/events`);
    source.onmessage = (e) => {
      const event = JSON.parse(e.data);
      switch (event.kind) {
        case 'log':
          addLog(event.message, event.type as LogType);
          break;
        case 'progress':
          setCurrentIndex(event.index);
          setTotalMembers(event.total);
          break;
        case 'stats':
          // Record a timestamp for each newly-sent message (for the speed chart).
          if (event.sent > lastSentRef.current) {
            const now = Date.now();
            for (let k = lastSentRef.current; k < event.sent; k++) sentTimesRef.current.push(now);
          }
          lastSentRef.current = event.sent;
          setSentCount(event.sent);
          setSkippedCount(event.skipped);
          setFailedCount(event.failed);
          break;
        case 'status':
          setStatus(event.status as Status);
          if (event.status === 'done') setShowFinished(true);
          break;
        case 'historyUpdated':
          fetchHistory();
          break;
        case 'scrapeLog':
          setScrapeLogs((prev) => [...prev, event.message]);
          break;
        case 'scrapeDone':
          setScrapedUrls(event.urls);
          setIsScraping(false);
          break;
        case 'loginLog':
          setLoginLogs((prev) => [...prev, event.message]);
          break;
        case 'loginDone':
          setIsLoggingIn(false);
          if (event.ok) {
            setView('app');
            // Reuse a previously-scraped member list for this community.
            loadSavedMembers(communityUrlRef.current).then((n) => {
              if (n > 0) addLog(`Loaded ${n} saved members — no need to re-scrape.`, 'success');
            });
          }
          break;
      }
    };
    return () => source.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Backstop for the login screen. EventSource reconnects on its own, but every
  // event emitted while it was down is gone for good — and `loginDone` is the
  // only thing that clears this screen, so one dropped stream during the 3-minute
  // manual-login window left the button stuck on "Waiting for login..." forever.
  // The backend's `busy` flag is the durable truth; two consecutive "not busy"
  // readings mean the run ended and we missed its event.
  useEffect(() => {
    if (!isLoggingIn) return;
    let idle = 0;
    const id = setInterval(async () => {
      try {
        const { busy } = await (await fetch(`${API}/api/health`)).json();
        if (busy) {
          idle = 0;
          return;
        }
        if (++idle < 2) return;
        setIsLoggingIn(false);
        setLoginLogs((prev) => [
          ...prev,
          'Lost contact with the run before it reported back — try again.',
        ]);
      } catch {
        /* backend unreachable — keep waiting; handleLogin already reports that */
      }
    }, 4000);
    return () => clearInterval(id);
  }, [isLoggingIn]);

  // Real-time sending-speed sampler: every 2s while active, count messages sent
  // in the trailing 60s and append to the speed series.
  useEffect(() => {
    if (!isActive) return;
    const id = setInterval(() => {
      const now = Date.now();
      // Drop timestamps that have aged out instead of re-filtering an array
      // that grows with every message sent for the life of the campaign.
      const recent = sentTimesRef.current.filter((t) => now - t <= 60000);
      sentTimesRef.current = recent;
      setSpeedSeries((prev) => [...prev.slice(-39), recent.length]);
    }, 2000);
    return () => clearInterval(id);
  }, [isActive]);

  // Push delay changes to the backend live, so adjusting it mid-run (e.g. while
  // paused) actually changes the sending speed on resume.
  useEffect(() => {
    if (!isActive) return;
    fetch(`${API}/api/delay`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ delay }),
    }).catch(() => {});
  }, [delay, isActive]);

  // ─── Login screen ──────────────────────────────────────────────────────────
  if (view === 'login') {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center font-sans p-4">
        <div className="w-full max-w-md">
          <div className="flex items-center gap-3 mb-6 justify-center">
            <div className="w-12 h-12 bg-accent/20 rounded-[8px] flex items-center justify-center text-2xl">
              🧭
            </div>
            <div>
              <h1 className="font-semibold text-text text-lg">Atlas</h1>
              <p className="text-xs text-muted">Sign in to continue</p>
            </div>
          </div>

          <div className="bg-surface border border-border rounded-[8px] p-6 space-y-4">
            <div>
              <label className="block text-sm text-text mb-1">Community URL</label>
              <input
                type="text"
                className="input-field"
                placeholder="https://community.iaug.org"
                value={communityUrl}
                onChange={(e) => setCommunityUrl(e.target.value)}
                disabled={isLoggingIn}
              />
            </div>

            <div>
              <label className="block text-sm text-text mb-1">
                Email <span className="text-muted font-normal">(optional)</span>
              </label>
              <input
                type="email"
                className="input-field"
                placeholder="your@email.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={isLoggingIn}
              />
            </div>
            <div>
              <label className="block text-sm text-text mb-1">
                Password <span className="text-muted font-normal">(optional)</span>
              </label>
              <input
                type="password"
                className="input-field"
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={isLoggingIn}
                onKeyDown={(e) => e.key === 'Enter' && handleLogin()}
              />
            </div>

            <Toggle
              label="Show browser window"
              description="Keep ON — a Chrome window opens so you can log in"
              checked={showBrowser}
              onChange={setShowBrowser}
            />

            {!isLoggingIn ? (
              <button
                className="btn-primary flex items-center justify-center gap-2"
                disabled={!isLoginValid}
                onClick={handleLogin}
              >
                <Lock className="w-4 h-4" />
                Open browser & log in
              </button>
            ) : (
              <div className="space-y-2">
                <button className="btn-primary flex items-center justify-center gap-2" disabled>
                  <Lock className="w-4 h-4" />
                  Waiting for login in the window...
                </button>
                <button className="btn-danger-outline" onClick={cancelLogin}>
                  Cancel
                </button>
              </div>
            )}

            <div className="flex items-start gap-1.5">
              <Lock className="w-3 h-3 text-muted mt-0.5 flex-shrink-0" />
              <p className="text-xs text-muted">
                A Chrome window opens. If your community has "Sign in with Google",
                we open it pre-filled with your email — just finish with your Google
                password / 2FA. Your details never leave your machine.
              </p>
            </div>

            {loginLogs.length > 0 && (
              <div className="bg-background rounded-[8px] border border-border p-3 max-h-[160px] overflow-y-auto font-mono text-xs">
                {loginLogs.map((log, i) => (
                  <p key={i} className="text-muted mb-1">{log}</p>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ─── Main app ──────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-background flex flex-col font-sans">
      {/* Header */}
      <header className="w-full h-16 bg-surface border-b border-border flex items-center justify-between px-6 flex-shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-accent/20 rounded-[8px] flex items-center justify-center text-xl">
            🧭
          </div>
          <div>
            <h1 className="font-semibold text-text">Atlas</h1>
            <p className="text-xs text-muted">{communityUrl || 'Workspace'}</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 bg-surface-2 border border-border rounded-full px-3 py-1.5">
            <div
              className={`w-2.5 h-2.5 rounded-full ${getStatusColor(status)} ${
                status === 'running' ? 'animate-pulse-dot' : ''
              }`}
            />
            <span className="text-sm text-muted font-medium w-16">{getStatusText(status)}</span>
          </div>
          <button
            onClick={handleLogout}
            disabled={isRunning}
            className="text-sm text-muted hover:text-text transition-colors disabled:opacity-40"
          >
            Log out
          </button>
        </div>
      </header>

      {/* Main content — stacks vertically on small screens, side-by-side on lg+ */}
      <div className="flex flex-col lg:flex-row flex-1 lg:overflow-hidden overflow-y-auto">
        {/* Left Panel - Config Form */}
        <div className="w-full lg:w-[420px] flex-shrink-0 bg-surface lg:overflow-y-auto border-b lg:border-b-0 border-border">
          <div className="p-5 space-y-5">
            {/* Message — drops open on click */}
            <div>
              <button
                className="btn-ghost flex items-center justify-center gap-2"
                onClick={() => setShowMessageBox((v) => !v)}
              >
                <MessageSquare className="w-4 h-4" />
                {showMessageBox ? 'Hide message' : 'Message'}
                {message.trim() && (
                  <span className="text-xs text-muted">({charCount})</span>
                )}
              </button>
              {showMessageBox && (
                <div className="mt-2">
                  <textarea
                    className="input-field min-h-[100px] resize-y"
                    placeholder="Hi! I wanted to reach out and connect with you..."
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                  />
                  <div className="flex justify-between mt-1.5">
                    <p className="text-xs text-muted">{charCount} characters</p>
                    <p className="text-xs text-muted">Same message sent to every member</p>
                  </div>
                </div>
              )}
            </div>

            {/* Member profile URLs — drops open on click */}
            <div>
              <button
                className="btn-ghost flex items-center justify-center gap-2"
                onClick={() => setShowMemberBox((v) => !v)}
              >
                <LinkIcon className="w-4 h-4" />
                {showMemberBox ? 'Hide member profile URLs' : 'Member profile URLs'}
                {memberCount > 0 && (
                  <span className="text-xs text-muted">({memberCount})</span>
                )}
              </button>
              {showMemberBox && (
                <div className="mt-2">
                  <textarea
                    className="input-field font-mono min-h-[140px] resize-y text-sm"
                    placeholder={`https://community.iaug.org/u/john\nhttps://community.iaug.org/u/jane\nhttps://community.iaug.org/u/alex`}
                    value={memberUrls}
                    onChange={(e) => setMemberUrls(e.target.value)}
                  />
                  <div className="flex justify-between mt-1.5">
                    <p className="text-xs text-muted">One URL per line — /u/&lt;username&gt;</p>
                    <span className="text-xs bg-surface-2 text-text px-2 py-0.5 rounded font-mono">
                      {memberCount} members
                    </span>
                  </div>
                </div>
              )}
            </div>

            <hr className="border-border" />

            {/* Section: Options */}
            <div>
              <label className="block text-xs uppercase text-muted font-medium mb-3">Options</label>
              <div className="space-y-4">
                {/* Delay */}
                <div>
                  <label className="block text-sm text-text mb-1">Delay between messages</label>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      className="input-field w-20 text-center"
                      min={0}
                      max={60}
                      value={delay}
                      onChange={(e) => setDelay(Math.max(0, Math.min(60, parseInt(e.target.value) || 0)))}
                    />
                    <span className="text-sm text-muted">seconds</span>
                  </div>
                  <p className="text-xs text-muted mt-1">
                    How often each tab starts a message. 0 = as fast as the pages load.
                  </p>
                </div>

                {/* Parallel tabs */}
                <div>
                  <label className="block text-sm text-text mb-1">Members at a time</label>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      className="input-field w-20 text-center"
                      min={1}
                      max={8}
                      value={concurrency}
                      onChange={(e) =>
                        setConcurrency(Math.max(1, Math.min(8, parseInt(e.target.value) || 1)))
                      }
                    />
                    <span className="text-sm text-muted">tabs</span>
                  </div>
                  <p className="text-xs text-muted mt-1">
                    Each tab works a different member. More = faster, and more load on the
                    community at once.
                  </p>
                </div>

                {/* Show browser */}
                <Toggle
                  label="Show browser window"
                  description="Turn on to watch it work"
                  checked={showBrowser}
                  onChange={setShowBrowser}
                />

                <hr className="border-border" />

                {/* Skip rules */}
                <Toggle
                  label="Skip already-messaged"
                  description="Skip members you've messaged in a previous run"
                  checked={skipAlreadySent}
                  onChange={setSkipAlreadySent}
                />
                <Toggle
                  label="Skip existing conversations"
                  description="Skip if you've already chatted or connected"
                  checked={skipExistingConversation}
                  onChange={setSkipExistingConversation}
                />
                <Toggle
                  label="Skip admins & moderators"
                  description="Skip staff / community managers"
                  checked={skipModerators}
                  onChange={setSkipModerators}
                />
              </div>
            </div>

            <hr className="border-border" />

            {/* Action Buttons */}
            <div className="space-y-3 pb-4">
              {!isActive ? (
                <button
                  className="btn-primary flex items-center justify-center gap-2"
                  disabled={!isFormValid}
                  onClick={startSending}
                >
                  <Send className="w-4 h-4" />
                  Start sending
                </button>
              ) : (
                <div className="flex gap-3">
                  <button
                    className="btn-primary flex items-center justify-center gap-2"
                    onClick={togglePause}
                  >
                    {isPaused ? (
                      <>
                        <Play className="w-4 h-4" />
                        Resume
                      </>
                    ) : (
                      <>
                        <Pause className="w-4 h-4" />
                        Pause
                      </>
                    )}
                  </button>
                  <button
                    className="btn-danger-outline flex items-center justify-center gap-2"
                    onClick={stopSending}
                  >
                    <Square className="w-4 h-4" />
                    Stop
                  </button>
                </div>
              )}

              <button
                className="btn-ghost flex items-center justify-center gap-2"
                onClick={() => setIsModalOpen(true)}
              >
                <Search className="w-4 h-4" />
                Scrape member URLs
              </button>
            </div>
          </div>
        </div>

        {/* Right Panel - Stats, graph, history */}
        <div className="flex-1 bg-background flex flex-col lg:overflow-y-auto">
          {/* Stats + donut graph */}
          <div className="p-5 pb-0">
            <div className="flex flex-col sm:flex-row gap-5 items-center">
              <DonutChart sent={sentCount} skipped={skippedCount} failed={failedCount} />
              <ProgressRing value={sentCount + skippedCount + failedCount} total={totalMembers} />
              <div className="grid grid-cols-3 gap-3 flex-1 w-full">
                {/* Sent */}
                <div className="bg-surface rounded-[8px] p-4 border border-border">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="w-2 h-2 rounded-full" style={{ background: '#22c55e' }} />
                    <span className="text-sm text-muted">Sent</span>
                  </div>
                  <p className="text-2xl font-mono text-success font-medium">{sentCount}</p>
                </div>

                {/* Skipped */}
                <div className="bg-surface rounded-[8px] p-4 border border-border">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="w-2 h-2 rounded-full" style={{ background: '#f59e0b' }} />
                    <span className="text-sm text-muted">Skipped</span>
                  </div>
                  <p className="text-2xl font-mono text-warning font-medium">{skippedCount}</p>
                </div>

                {/* Failed */}
                <div className="bg-surface rounded-[8px] p-4 border border-border">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="w-2 h-2 rounded-full" style={{ background: '#ef4444' }} />
                    <span className="text-sm text-muted">Failed</span>
                  </div>
                  <p className="text-2xl font-mono text-error font-medium">{failedCount}</p>
                </div>
              </div>
            </div>

            {/* Real-time sending-speed chart */}
            <div className="mt-4">
              <SpeedChart series={speedSeries} />
            </div>
          </div>

          {/* Progress Bar */}
          {isActive && totalMembers > 0 && (
            <div className="px-5 pt-4">
              <div className="h-[3px] bg-surface-2 rounded-full overflow-hidden">
                <div
                  className="h-full bg-accent transition-all duration-300"
                  style={{ width: `${(currentIndex / totalMembers) * 100}%` }}
                />
              </div>
              <p className="text-xs text-muted mt-1.5">
                {isPaused ? 'Paused' : 'Sending'} at member {currentIndex} of {totalMembers}
                {isPaused ? ' (paused)' : '...'}
              </p>
            </div>
          )}

          {/* Two toggle buttons in a ROW; panels drop down below the row */}
          <div className="px-5 pt-5">
            <div className="flex gap-2">
              <button
                className="btn-ghost flex items-center justify-center gap-2"
                onClick={() => setShowCommunities((v) => !v)}
              >
                <Users className="w-4 h-4" />
                {showCommunities ? 'Hide community list' : 'Community list'}
                {!showCommunities && communities.length > 0 && (
                  <span className="text-xs text-muted">({communities.length})</span>
                )}
              </button>
              <button
                className="btn-ghost flex items-center justify-center gap-2"
                onClick={() => setShowHistory((v) => !v)}
              >
                <History className="w-4 h-4" />
                {showHistory ? 'Hide message history' : 'Message history'}
                {!showHistory && logs.length > 0 && (
                  <span className="text-xs text-muted">({logs.length})</span>
                )}
              </button>
            </div>

            {/* Community list panel */}
            {showCommunities && (
              <div className="space-y-2 max-h-[40vh] overflow-y-auto pr-0.5 mt-2">
                {communities.length === 0 ? (
                  <p className="text-sm text-muted text-center py-4">No communities yet.</p>
                ) : (
                  communities.map((c) => {
                    const host = c.communityUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
                    return (
                      <div key={c.communityUrl} className="bg-surface rounded-[8px] p-3 border border-border">
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-sm text-text truncate pr-2">{host}</span>
                          <span className="text-sm font-mono text-text flex-shrink-0">{c.completionRate}%</span>
                        </div>
                        <div className="h-2 bg-surface-2 rounded-full overflow-hidden flex">
                          <div className="h-full" style={{ background: '#22c55e', width: `${pct(c.sent, c.totalMembers)}%` }} />
                          <div className="h-full" style={{ background: '#f59e0b', width: `${pct(c.skipped, c.totalMembers)}%` }} />
                          <div className="h-full" style={{ background: '#ef4444', width: `${pct(c.failed, c.totalMembers)}%` }} />
                        </div>
                        <div className="flex justify-between mt-1.5 text-xs text-muted">
                          <span>
                            {c.processed} / {c.totalMembers} contacted
                          </span>
                          <span>
                            {c.sent} sent · {c.skipped} skipped · {c.failed} failed
                          </span>
                        </div>
                        {c.scrapedMembers > 0 && (
                          <div className="flex items-center justify-between mt-2 pt-2 border-t border-border">
                            <span className="text-xs text-muted">
                              {c.scrapedMembers} members saved
                            </span>
                            <button
                              className="text-xs text-accent hover:underline"
                              onClick={async () => {
                                setCommunityUrl(c.communityUrl);
                                const n = await loadSavedMembers(c.communityUrl);
                                addLog(`Loaded ${n} saved members from ${host}.`, 'success');
                              }}
                            >
                              Load members
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            )}

            {/* Message history panel */}
            {showHistory && (
              <div className="bg-surface rounded-[8px] border border-border flex flex-col overflow-hidden max-h-[50vh] mt-2">
                <div className="flex items-center justify-between px-4 py-2 border-b border-border">
                  <span className="text-xs uppercase text-muted font-medium">Message history</span>
                  <button
                    className="text-xs text-muted hover:text-text flex items-center gap-1 transition-colors"
                    onClick={clearLogs}
                  >
                    <Trash2 className="w-3 h-3" />
                    Clear
                  </button>
                </div>
                <div className="overflow-y-auto p-3 font-mono text-sm">
                  {logs.length === 0 ? (
                    <div className="flex flex-col items-center justify-center text-muted py-8">
                      <Bot className="w-10 h-10 mb-3 opacity-50" />
                      <p className="text-sm">No activity yet</p>
                    </div>
                  ) : (
                    <div className="space-y-1">
                      {logs.map((log) => (
                        <div
                          key={log.id}
                          className={`flex items-start py-1.5 px-2 rounded ${getLogRowStyle(log.type)}`}
                        >
                          <span className="text-muted shrink-0 w-16">{log.timestamp}</span>
                          <span className={`${getLogTextStyle(log.type)} pl-2`}>{log.message}</span>
                        </div>
                      ))}
                      <div ref={logEndRef} />
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          <div className="pb-5" />
        </div>
      </div>

      {/* Finished alert */}
      {showFinished && (
        <div
          className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4"
          onClick={() => setShowFinished(false)}
        >
          <div
            className="bg-surface w-full max-w-sm rounded-[8px] border border-border shadow-xl p-6 text-center"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="w-14 h-14 rounded-full bg-success/15 flex items-center justify-center mx-auto mb-4 text-3xl">
              🎉
            </div>
            <h2 className="font-semibold text-text text-lg mb-1">All done!</h2>
            <p className="text-sm text-muted mb-5">
              Finished messaging all {totalMembers} members.
            </p>
            <div className="grid grid-cols-3 gap-3 mb-6">
              <div>
                <p className="text-2xl font-mono text-success font-medium">{sentCount}</p>
                <p className="text-xs text-muted">Sent</p>
              </div>
              <div>
                <p className="text-2xl font-mono text-warning font-medium">{skippedCount}</p>
                <p className="text-xs text-muted">Skipped</p>
              </div>
              <div>
                <p className="text-2xl font-mono text-error font-medium">{failedCount}</p>
                <p className="text-xs text-muted">Failed</p>
              </div>
            </div>
            <button className="btn-primary" onClick={() => setShowFinished(false)}>
              Done
            </button>
          </div>
        </div>
      )}

      {/* Scrape Members Modal */}
      {isModalOpen && (
        <div
          className="fixed inset-0 bg-black/80 flex items-center justify-center z-50"
          onClick={closeModal}
        >
          <div
            className="bg-surface w-[480px] rounded-[8px] border border-border shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between p-4 border-b border-border">
              <h2 className="font-semibold text-text">Scrape member URLs</h2>
              <button
                onClick={closeModal}
                className="text-muted hover:text-text transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-4 space-y-4">
              <p className="text-sm text-muted">
                Collects <span className="text-text font-medium">every member</span> profile URL from the
                community directory. This can take a minute for large communities.
              </p>

              {/* Scrape Log */}
              <div className="bg-background rounded-[8px] border border-border p-3 h-[120px] overflow-y-auto font-mono text-xs">
                {scrapeLogs.length === 0 ? (
                  <p className="text-muted">Click Start scraping to begin...</p>
                ) : (
                  scrapeLogs.map((log, i) => (
                    <p key={i} className="text-muted mb-1">
                      {log}
                    </p>
                  ))
                )}
              </div>

              {scrapedUrls.length > 0 && (
                <div className="flex items-center gap-2 text-success">
                  <span className="text-sm">✓ {scrapedUrls.length} URLs found</span>
                </div>
              )}
            </div>

            <div className="p-4 border-t border-border flex gap-3">
              {scrapedUrls.length > 0 ? (
                <>
                  <button className="btn-primary" onClick={addToMemberList}>
                    Add to member list
                  </button>
                  <button className="btn-ghost" onClick={closeModal}>
                    Cancel
                  </button>
                </>
              ) : isScraping ? (
                <>
                  <button className="btn-primary" disabled>
                    Scraping all members...
                  </button>
                  <button className="btn-danger-outline" onClick={stopScraping}>
                    Stop &amp; keep results
                  </button>
                </>
              ) : (
                <>
                  <button className="btn-primary" onClick={startScraping}>
                    Scrape all members
                  </button>
                  <button className="btn-ghost" onClick={closeModal}>
                    Cancel
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
