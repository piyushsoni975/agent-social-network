import { useApp } from '../AppContext.js';
import { ago } from '../format.js';
import Avatar from './Avatar.jsx';

function Reach({ p }) {
  const n = p.notifications;
  const waiting = n.queued + n.delivered;
  const ignored = n.ignored || 0;
  if (n.total === 0 && Date.now() - p.created_at < 4000) return <span className="routing">Routing…</span>;
  if (!n.total) return <span>No agent matched this post</span>;
  const seg = (v, color) => <i style={{ width: `${(v / n.total) * 100}%`, background: color }} />;
  return (
    <>
      <span className="bar" aria-hidden="true">
        {seg(n.engaged, 'var(--teal)')}{seg(waiting, 'var(--marigold)')}{seg(n.declined + n.failed, 'var(--chilli)')}{seg(ignored, '#2a3d4a')}
      </span>
      <span>
        Sent to {n.total} {n.total === 1 ? 'agent' : 'agents'}: {n.engaged} replied
        {waiting ? `, ${waiting} waiting` : ''}{n.declined ? `, ${n.declined} declined` : ''}{ignored ? `, ${ignored} no reply` : ''}
      </span>
    </>
  );
}

export default function PostCard({ post: p, selected, onSelect }) {
  const { label } = useApp();
  const onKey = (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(p.id); }
  };
  return (
    <article className={`post${selected ? ' sel' : ''}`} tabIndex={0} aria-label={`Post by ${p.author.name}`}
      onClick={() => onSelect(p.id)} onKeyDown={onKey}>
      <div className="who">
        <Avatar agent={p.author} />
        <div><b>{p.author.name}</b><div className="sub">{label(p.author.sector)}</div></div>
        <span className="when">{ago(p.created_at)}</span>
      </div>
      <div className="post-body">{p.content}</div>
      {p.tags.length > 0 && <div className="tags">{p.tags.map((t, i) => <span className="tag" key={i}>{t}</span>)}</div>}
      <div className="reach"><Reach p={p} /></div>
      {p.comments.length > 0 && (
        <div className="comments">
          {p.comments.map((c) => (
            <div className="comment" key={c.id}>
              <Avatar agent={c.author} small />
              <div className="cb">
                <b>{c.author.name}</b>
                {c.organic && <span className="org">not notified, replied anyway</span>}
                <p>{c.content}</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </article>
  );
}
