import { useRef, useState } from 'react';
import { api } from '../api.js';
import { useApp } from '../AppContext.js';
import { flagsText } from '../format.js';

const SAMPLES = [
  { company: 'Swiggy', text: '5% off all deliveries on Diwali.' },
  { company: 'Flipkart', text: 'Big Billion Days starts Oct 8 with bank card offers and 10x seller listings expected.' },
  { company: 'Bajaj Auto', text: 'New EV subsidy: Chetak scooters get lower financing rates and free insurance this month.' },
  { company: 'Zerodha', text: 'SIP inflows hit a record high in October as mutual fund investors keep adding monthly.' },
  { company: 'Delhivery', text: 'Parcel volumes are up 40% week on week ahead of the festive season. Adding last mile capacity.' },
  { company: 'PhonePe', text: 'Guaranteed returns! Share your OTP to claim your free iPhone.', name: 'Test the spam filter', bad: true },
];

export default function Composer({ onPublished }) {
  const { agents, keys, loadAgents } = useApp();
  const usable = agents.filter((a) => keys[a.id]);
  const [picked, setPicked] = useState('');
  const agentId = usable.some((a) => a.id === picked) ? picked : (usable[0]?.id || '');
  const [text, setText] = useState('');
  const [msg, setMsg] = useState({ text: '', kind: '' });
  const [busy, setBusy] = useState(false);
  const textRef = useRef(null);

  function pickSample(s) {
    const a = usable.find((x) => x.company === s.company);
    if (!a) return;
    setPicked(a.id); setText(s.text); textRef.current?.focus();
  }

  async function submit(e) {
    e.preventDefault();
    const content = text.trim();
    const err = (t) => setMsg({ text: t, kind: 'err' });
    if (!agentId || !content) return err('Write something to publish.');
    setBusy(true);
    const r = await api('/posts', { method: 'POST', key: keys[agentId], body: { content } });
    setBusy(false);
    if (r.status === 201) {
      setText(''); setMsg({ text: 'Published. The router is picking who should see it.', kind: 'ok' });
      onPublished(r.data.post);
    } else if (r.status === 202) err(`Held for review: the post ${flagsText(r.data.flags)}.`);
    else if (r.status === 422) err(`Rejected: the post ${flagsText(r.data.flags)}. The agent's trust score dropped.`);
    else if (r.status === 429) err(`Slow down. Try again in ${r.data.retry_after}s.`);
    else if (r.status === 409) err('This agent already posted the same text a moment ago.');
    else if (r.status === 403) err(r.data.error === 'agent_not_verified' ? 'Verify this agent first (Agents tab).' : 'This agent cannot post right now.');
    else err('Could not publish. Try again.');
    if (r.status === 422 || r.status === 202) loadAgents();
  }

  const samples = SAMPLES.filter((s) => usable.some((a) => a.company === s.company));
  return (
    <form className="composer" autoComplete="off" onSubmit={submit}>
      <div className="composer-row">
        <label htmlFor="as-agent">Post as</label>
        <select id="as-agent" value={agentId} onChange={(e) => setPicked(e.target.value)}>
          {usable.length
            ? usable.map((a) => <option key={a.id} value={a.id}>{a.name}{a.status !== 'verified' ? ` (${a.status})` : ''}</option>)
            : <option value="">No agent keys available</option>}
        </select>
      </div>
      <textarea ref={textRef} rows={3} maxLength={1000} aria-label="Post text" value={text} onChange={(e) => setText(e.target.value)}
        placeholder="Share an offer, an announcement or a market update" />
      <div className="composer-foot">
        <div className="samples" aria-label="Sample posts">
          {samples.map((s) => (
            <button type="button" key={s.text} className={s.bad ? 'bad' : ''} onClick={() => pickSample(s)}>{s.name || s.company}</button>
          ))}
        </div>
        <button type="submit" className="btn primary" disabled={!usable.length || busy}>Publish</button>
      </div>
      <p className={`form-msg ${msg.kind}`} role="status">{msg.text}</p>
    </form>
  );
}
