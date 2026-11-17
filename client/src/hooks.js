import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.js';

const newestFirst = (arr) => [...arr].sort((a, b) => b.created_at - a.created_at);

/** Feed state: post cards, per-post detail (routing trace + delivery), and the selected post. */
export function useFeed() {
  const [posts, setPosts] = useState([]);
  const [details, setDetails] = useState({});
  const [selected, setSelected] = useState(null);
  const timers = useRef(new Map());

  const upsertPost = useCallback((p) => {
    setPosts((prev) => newestFirst(prev.some((x) => x.id === p.id) ? prev.map((x) => (x.id === p.id ? { ...x, ...p } : x)) : [p, ...prev]));
  }, []);

  // Many live events can arrive for one post in a burst; coalesce them into one fetch.
  const refreshPost = useCallback((pid) => {
    clearTimeout(timers.current.get(pid));
    timers.current.set(pid, setTimeout(async () => {
      timers.current.delete(pid);
      const r = await api(`/posts/${pid}`);
      if (!r.ok) return;
      setDetails((d) => ({ ...d, [pid]: r.data }));
      const { route, delivery, ...card } = r.data;   // eslint-disable-line no-unused-vars
      setPosts((prev) => {
        const rest = prev.filter((x) => x.id !== pid);
        return card.status === 'published' ? newestFirst([card, ...rest]) : rest;
      });
    }, 120));
  }, []);

  const loadFeed = useCallback(async () => {
    const r = await api('/posts?limit=30');
    if (r.ok) setPosts(r.data);
    return r.ok ? r.data : [];
  }, []);

  const select = useCallback((pid) => { setSelected(pid); refreshPost(pid); }, [refreshPost]);
  const reset = useCallback(() => { setPosts([]); setDetails({}); setSelected(null); }, []);

  return { posts, details, selected, upsertPost, refreshPost, loadFeed, select, reset };
}

/** Server-Sent Events from /api/stream. The handler can change every render; the connection does not. */
export function useStream(onEvent, onStatus) {
  const handler = useRef(onEvent);
  useEffect(() => { handler.current = onEvent; });
  useEffect(() => {
    const es = new EventSource('/api/stream');
    es.onopen = () => onStatus('on');
    es.onerror = () => onStatus('off');
    es.onmessage = (m) => {
      let e;
      try { e = JSON.parse(m.data); } catch { return; }
      handler.current(e);
    };
    return () => es.close();
  }, [onStatus]);
}

/** Re-render on an interval so relative times ("2m ago") stay fresh. */
export function useTick(ms) {
  const [, setT] = useState(0);
  useEffect(() => {
    const i = setInterval(() => setT((x) => x + 1), ms);
    return () => clearInterval(i);
  }, [ms]);
}
