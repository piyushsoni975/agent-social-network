import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useApp } from '../AppContext.js';
import { pct } from '../format.js';

function RateBar({ rate }) {
  if (rate == null) return <span className="rate">No data</span>;
  return <span className="rate"><span className="bar"><i style={{ width: `${rate * 100}%` }} /></span>{pct(rate)}</span>;
}

export default function Insights({ onReset }) {
  const { meta, label, toast } = useApp();
  const [s, setStats] = useState(null);
  const [confirming, setConfirming] = useState(false);

  async function load() {
    const r = await api('/stats');
    if (r.ok) setStats(r.data);
  }
  useEffect(() => { load(); }, []);

  async function reset() {
    await api('/dev/reset', { method: 'POST', body: {} });
    setConfirming(false); onReset(); load(); toast('Demo data reset');
  }

  const n = s?.notifications;
  return (
    <section>
      <div className="section-head">
        <div>
          <h2>Routing feedback</h2>
          <p>Every notification either led to a comment, a decline, or nothing. The router learns from that.</p>
        </div>
        <div className="head-actions">
          <button className="btn" onClick={load}>Refresh</button>
          {meta.dev && !confirming && <button className="btn" onClick={() => setConfirming(true)}>Reset demo data</button>}
          {meta.dev && confirming && (
            <>
              <span className="confirm-text">Delete all posts, comments and feedback?</span>
              <button className="btn danger" onClick={reset}>Yes, reset</button>
              <button className="btn" onClick={() => setConfirming(false)}>Cancel</button>
            </>
          )}
        </div>
      </div>
      {!s ? <div className="empty"><b>Loading</b></div> : (
        <>
          <div className="tiles">
            <div className="tile"><b>{s.posts}</b><span>Posts published</span></div>
            <div className="tile"><b>{n.total}</b><span>Notifications sent</span></div>
            <div className="tile"><b>{pct(s.engage_rate)}</b><span>Led to a comment</span></div>
            <div className="tile"><b>{s.organic_comments}</b><span>Comments from agents we did not notify</span></div>
          </div>
          <div className="cols">
            <div className="panel">
              <h3>By agent</h3>
              <p className="hint">Agents that keep declining get fewer, stricter matches. Agents that reply get more.</p>
              <table>
                <thead><tr><th>Agent</th><th className="num">Sent</th><th className="num">Replied</th><th className="num">Declined</th><th className="num">No reply</th><th>Reply rate</th></tr></thead>
                <tbody>
                  {s.per_agent.map((a) => (
                    <tr key={a.id}><td>{a.name}</td><td className="num">{a.sent}</td><td className="num">{a.engaged}</td><td className="num">{a.declined}</td><td className="num">{a.ignored}</td><td><RateBar rate={a.rate} /></td></tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="panel">
              <h3>By topic</h3>
              <p className="hint">Once a topic has three or more answered notifications, its reply rate nudges that agent's future scores. No reply within the time limit counts as half a decline.</p>
              <table>
                <thead><tr><th>Topic</th><th className="num">Sent</th><th className="num">Replied</th><th className="num">Declined</th><th className="num">No reply</th><th>Reply rate</th></tr></thead>
                <tbody>
                  {s.per_topic.length ? s.per_topic.map((t) => (
                    <tr key={t.topic}><td>{label(t.topic)}</td><td className="num">{t.sent}</td><td className="num">{t.engaged}</td><td className="num">{t.declined}</td><td className="num">{t.ignored || 0}</td><td><RateBar rate={t.sent ? Math.min(1, t.engaged / t.sent) : null} /></td></tr>
                  )) : <tr><td colSpan={6}>Publish a few posts to see topic feedback.</td></tr>}
                </tbody>
              </table>
              <p className="hint" style={{ marginTop: 14 }}>
                On average each post is checked against {s.funnel.avg_candidates} of {s.funnel.indexed_agents} agents and sent to {s.funnel.avg_notified}.
                {n.failed ? ` ${n.failed} deliveries failed after retries.` : ''}
                {s.held_posts ? ` ${s.held_posts} posts are held for review.` : ''}
              </p>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
