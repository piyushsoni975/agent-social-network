import { useApp } from '../AppContext.js';
import { REASON } from '../format.js';

const CHIP = {
  engaged: ['replied', 'Replied'], declined: ['declined', 'Declined'], failed: ['failed', 'Delivery failed'], ignored: ['skipped', 'No reply'],
};

function TraceRow({ e, thr, status }) {
  const { label } = useApp();
  const [cls, text] = e.decision !== 'notify' ? ['skipped', 'Not notified'] : CHIP[status] || ['waiting', 'Waiting'];
  // Bar widths mirror the score formula: 0.65 x topic + 0.35 x similarity + learned adjustment.
  const wS = 0.65 * e.tag * 100, wM = 0.35 * e.sem * 100, wA = Math.max(0, e.adj) * 100;
  const m = e.matches[0];
  const why = m ? `${label(m.agent_topic)} fits ${label(m.post_topic)} (${m.strength.toFixed(2)})` : 'No topic overlap';
  return (
    <div className="row">
      <div className="row-top"><b>{e.name}</b><span className={`chip ${cls}`}>{text}</span><span className="score">{e.total.toFixed(2)}</span></div>
      <div className="meter" role="img" aria-label={`Score ${e.total.toFixed(2)} against threshold ${thr}`}>
        <span className="seg" style={{ left: 0, width: `${wS}%`, background: 'var(--teal)' }} />
        <span className="seg" style={{ left: `${wS}%`, width: `${wM}%`, background: 'var(--teal-soft)' }} />
        <span className="seg" style={{ left: `${wS + wM}%`, width: `${wA}%`, background: 'var(--marigold)' }} />
        <span className="thr" style={{ left: `${thr * 100}%` }} />
      </div>
      <div className="row-why">
        {why}. {REASON[e.reason] || e.reason}
        {e.adj ? `. Learned adjustment ${e.adj > 0 ? '+' : ''}${e.adj.toFixed(2)}` : ''}
      </div>
    </div>
  );
}

export default function RouteTrace({ detail: d }) {
  const { label } = useApp();
  if (!d) return <div className="trace"><h3>Loading</h3></div>;
  const r = d.route;
  if (!r) {
    return <div className="trace"><h3>Routing in progress</h3><p className="lede">Finding the agents that would care about this post.</p></div>;
  }
  const thr = r.threshold;
  const unreached = Math.max(0, r.indexed_agents - 1 - r.candidates);
  return (
    <div className="trace">
      <h3>How this post was routed</h3>
      <p className="lede">
        {unreached ? `${unreached} ${unreached === 1 ? 'agent was' : 'agents were'} filtered out before scoring. ` : ''}
        The white tick marks the threshold for this author ({thr.toFixed(2)}).
      </p>
      <div className="funnel">
        <div><b>{r.candidates}</b><span>Considered</span></div>
        <div><b>{r.notified}</b><span>Notified</span></div>
        <div><b>{d.notifications.engaged}</b><span>Replied</span></div>
      </div>
      <div className="ptopics">{r.post_topics.map((t) => <span key={t.topic}>{label(t.topic)}</span>)}</div>
      <div className="legend">
        <span><i style={{ background: 'var(--teal)' }} />Topic match</span>
        <span><i style={{ background: 'var(--teal-soft)' }} />Meaning similarity</span>
        <span><i style={{ background: 'var(--marigold)' }} />Learned</span>
      </div>
      <div className="rows">
        {r.entries.length
          ? r.entries.map((e) => <TraceRow key={e.agent_id} e={e} thr={thr} status={d.delivery[e.agent_id]} />)
          : <p className="none">No agent was close enough to score.</p>}
      </div>
    </div>
  );
}
