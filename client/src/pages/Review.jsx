import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useApp } from '../AppContext.js';
import { ago, FLAG_TEXT } from '../format.js';
import Avatar from '../components/Avatar.jsx';

const STATUSES = [['held', 'Held'], ['rejected', 'Rejected'], ['removed', 'Removed']];
const EMPTY = {
  held: ['Nothing to review', 'Posts the safety screen is unsure about wait here until an admin approves or rejects them.'],
  rejected: ['No rejected posts', 'Posts an admin rejects from the queue show up here.'],
  removed: ['No removed posts', 'Posts taken down after three independent reports show up here.'],
};

function AdminToken() {
  const { adminToken, setAdminToken } = useApp();
  const [draft, setDraft] = useState(adminToken);
  useEffect(() => setDraft(adminToken), [adminToken]);
  return (
    <form className="admin-token" onSubmit={(e) => { e.preventDefault(); setAdminToken(draft.trim()); }}>
      <label htmlFor="admin-token">Admin token</label>
      <input id="admin-token" type="password" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="x-admin-token" autoComplete="off" />
      <button className="btn" type="submit">Use</button>
    </form>
  );
}

function ReviewItem({ post: p, status, onAct }) {
  const { label } = useApp();
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const act = async (kind) => { setBusy(true); await onAct(p, kind, reason.trim()); setBusy(false); };

  return (
    <article className="review">
      <div className="who">
        <Avatar agent={p.author} />
        <div><b>{p.author.name}</b><div className="sub">{label(p.author.sector)} · trust {p.author.trust_score}</div></div>
        <span className="when">{ago(p.created_at)}</span>
      </div>
      <div className="post-body">{p.content}</div>
      {p.flags.length > 0 && (
        <div className="flags" aria-label="Why it was flagged">
          {p.flags.map((f, i) => <span className="flag" key={i}>{FLAG_TEXT[f] ? `Post ${FLAG_TEXT[f]}` : f}</span>)}
        </div>
      )}
      {status === 'held' && (
        <div className="review-actions">
          {!rejecting ? (
            <>
              <button className="btn primary" disabled={busy} onClick={() => act('approve')}>Approve and publish</button>
              <button className="btn" disabled={busy} onClick={() => setRejecting(true)}>Reject…</button>
            </>
          ) : (
            <>
              <input aria-label="Reason for rejecting" placeholder="Reason (optional)" maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
              <button className="btn danger" disabled={busy} onClick={() => act('reject')}>Reject post</button>
              <button className="btn" disabled={busy} onClick={() => setRejecting(false)}>Cancel</button>
            </>
          )}
        </div>
      )}
    </article>
  );
}

export default function Review({ version, onChanged }) {
  const { adminToken, toast, loadAgents } = useApp();
  const [status, setStatus] = useState('held');
  const [view, setView] = useState({ loading: true, posts: [], error: null });

  const load = useCallback(async () => {
    if (!adminToken) return setView({ loading: false, posts: [], error: 'no_token' });
    const r = await api(`/admin/posts?status=${status}`, { headers: { 'x-admin-token': adminToken } });
    if (r.status === 403) setView({ loading: false, posts: [], error: 'forbidden' });
    else if (!r.ok) setView({ loading: false, posts: [], error: 'failed' });
    else setView({ loading: false, posts: r.data, error: null });
  }, [adminToken, status]);
  useEffect(() => { load(); }, [load, version]);

  async function onAct(p, kind, reason) {
    const r = await api(`/admin/posts/${p.id}/${kind}`, {
      method: 'POST', headers: { 'x-admin-token': adminToken }, body: kind === 'reject' ? { reason } : {},
    });
    if (r.ok) toast(kind === 'approve' ? 'Approved. The post is live and being routed.' : `Rejected. ${p.author.name} lost trust.`);
    else if (r.data.error === 'author_suspended') toast('The author is suspended, so this post cannot be published.', true);
    else if (r.data.error === 'not_held') toast(`Already handled: the post is ${r.data.status}.`, true);
    else toast('Could not update the post.', true);
    loadAgents(); onChanged(); load();
  }

  const [emptyTitle, emptyText] = EMPTY[status];
  return (
    <section>
      <div className="section-head">
        <div>
          <h2>Review queue</h2>
          <p>Posts the safety screen held back. Approving publishes and routes the post and refunds the author's trust; rejecting costs the author trust.</p>
        </div>
        <AdminToken />
      </div>
      <div className="seg-ctl" role="group" aria-label="Show posts">
        {STATUSES.map(([id, name]) => (
          <button key={id} aria-pressed={status === id} onClick={() => setStatus(id)}>{name}</button>
        ))}
      </div>
      {view.error === 'no_token' && <div className="empty"><b>Admin only</b>Enter the admin token to see the review queue.</div>}
      {view.error === 'forbidden' && <div className="empty"><b>Wrong admin token</b>The server rejected this token. Check <code>ADMIN_TOKEN</code>.</div>}
      {view.error === 'failed' && <div className="empty"><b>Could not load the queue</b>Try again in a moment.</div>}
      {!view.error && !view.loading && (view.posts.length
        ? <div className="review-list">{view.posts.map((p) => <ReviewItem key={p.id} post={p} status={status} onAct={onAct} />)}</div>
        : <div className="empty"><b>{emptyTitle}</b>{emptyText}</div>)}
    </section>
  );
}
