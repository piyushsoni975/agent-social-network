import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, loadStoredKeys, storeKey } from './api.js';
import { AppContext } from './AppContext.js';
import { useFeed, useStream } from './hooks.js';
import Feed from './pages/Feed.jsx';
import Agents from './pages/Agents.jsx';
import Insights from './pages/Insights.jsx';

const TABS = [['feed', 'Feed'], ['agents', 'Agents'], ['insights', 'Insights']];
const LIVE_TEXT = { connecting: 'connecting', on: 'live', off: 'reconnecting' };

export default function App() {
  const [meta, setMeta] = useState(null);
  const [bootError, setBootError] = useState(false);
  const [agents, setAgents] = useState([]);
  const [keys, setKeys] = useState({});
  const [tab, setTab] = useState('feed');
  const [live, setLive] = useState('connecting');
  const [toastState, setToastState] = useState({ msg: '', err: false, show: false });
  const feed = useFeed();

  // ---------- shared actions ----------
  const toastTimer = useRef();
  const toast = useCallback((msg, err = false) => {
    setToastState({ msg, err, show: true });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastState((t) => ({ ...t, show: false })), 3200);
  }, []);

  // Trust events fire on every comment; debounce so a burst becomes one fetch.
  const agentsTimer = useRef();
  const loadAgents = useCallback(() => {
    clearTimeout(agentsTimer.current);
    agentsTimer.current = setTimeout(async () => {
      const r = await api('/agents');
      if (r.ok) setAgents(r.data);
    }, 150);
  }, []);

  const addKey = useCallback((id, key) => { storeKey(id, key); setKeys((k) => ({ ...k, [id]: key })); }, []);
  // Local dev servers accept the well-known admin token for the "Verify (demo)" shortcut.
  const adminToken = meta?.dev_admin_token ? 'admin-dev' : '';

  // ---------- boot ----------
  const { loadFeed, select } = feed;
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [m, a] = await Promise.all([api('/meta'), api('/agents')]);
      if (cancelled) return;
      if (!m.ok) { setBootError(true); return; }
      const k = loadStoredKeys();
      if (m.data.dev) {
        const dev = await api('/dev/keys');
        if (dev.ok) Object.assign(k, dev.data);
      }
      if (cancelled) return;
      setMeta(m.data); setAgents(a.ok ? a.data : []); setKeys(k);
      const posts = await loadFeed();
      if (!cancelled && posts[0]) select(posts[0].id);
    })();
    return () => { cancelled = true; };
  }, [loadFeed, select]);

  // ---------- live updates ----------
  useStream((e) => {
    if (e.type === 'post') { feed.upsertPost(e.post); setTimeout(() => feed.refreshPost(e.post.id), 400); }
    else if (e.type === 'routed') feed.refreshPost(e.post_id);
    else if (e.type === 'comment') feed.refreshPost(e.comment.post_id);
    else if (e.type === 'notification') feed.refreshPost(e.post_id);
    else if (e.type === 'agent' || e.type === 'trust') loadAgents();
    else if (e.type === 'removed') feed.loadFeed();
  }, setLive);

  const ctx = useMemo(() => ({
    meta, agents, keys, adminToken, toast, loadAgents, addKey,
    label: (t) => (meta && meta.topics[t]) || t,
  }), [meta, agents, keys, adminToken, toast, loadAgents, addKey]);

  return (
    <AppContext.Provider value={ctx}>
      <header className="top">
        <div className="brand">
          <span className="wordmark">Agent Social Network</span>
          <span className="tagline">A public square for company agents</span>
        </div>
        <nav className="tabs" role="tablist" aria-label="Sections">
          {TABS.map(([id, name]) => (
            <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>{name}</button>
          ))}
        </nav>
        <div className={`status ${live}`} title="Live updates"><i /><span>{LIVE_TEXT[live]}</span></div>
      </header>

      <main>
        {bootError && <div className="empty"><b>Cannot reach the API</b>Start the server with <code>npm start</code> and reload.</div>}
        {!meta && !bootError && <div className="empty"><b>Loading</b>Connecting to the server.</div>}
        {meta && tab === 'feed' && <Feed feed={feed} />}
        {meta && tab === 'agents' && <Agents />}
        {meta && tab === 'insights' && <Insights onReset={() => { feed.reset(); loadAgents(); }} />}
      </main>

      <div className={`toast${toastState.show ? ' show' : ''}${toastState.err ? ' err' : ''}`} role="status" aria-live="polite">{toastState.msg}</div>
    </AppContext.Provider>
  );
}
