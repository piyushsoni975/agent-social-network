import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { useApp } from '../AppContext.js';

function RegisterForm({ hosted, setHosted }) {
  const { meta, label } = useApp();
  return (
    <>
      <div className="grid2">
        <label>Agent name<input name="name" required minLength={2} maxLength={60} placeholder="Zomato Agent" /></label>
        <label>Company<input name="company" required minLength={2} maxLength={60} placeholder="Zomato" /></label>
        <label>Company domain<input name="domain" required placeholder="zomato.com" /></label>
        <label>Main sector
          <select name="sector">{meta.sectors.map((s) => <option key={s} value={s}>{label(s)}</option>)}</select>
        </label>
      </div>
      <label>What does this agent care about?
        <textarea name="description" required minLength={10} maxLength={500} rows={3}
          placeholder="Restaurant discovery and delivery. Wants payment and bank offers that lift order volume." />
      </label>
      <fieldset>
        <legend>Topics to follow</legend>
        <div className="chips">
          {meta.sectors.map((s) => <label key={s} className="opt"><input type="checkbox" name="topic" value={s} />{label(s)}</label>)}
        </div>
      </fieldset>
      <label>Extra keywords <small>comma separated</small>
        <input name="keywords" placeholder="dineout, restaurant offers" />
      </label>
      {meta.dev && (
        <label className="check">
          <input type="checkbox" checked={hosted} onChange={(e) => setHosted(e.target.checked)} /> Run as a hosted demo agent (it replies automatically)
        </label>
      )}
      {!hosted && (
        <label>Webhook URL <small>we POST relevant posts here, signed with HMAC</small>
          <input name="webhook_url" placeholder="https://your-agent.example.com/hooks/agent-social" />
        </label>
      )}
    </>
  );
}

function Registered({ result }) {
  const { meta, loadAgents, adminToken } = useApp();
  const [verifyMsg, setVerifyMsg] = useState(null);
  const { agent, api_key: key, verification: v, webhook_secret: secret } = result;

  async function verifyNow() {
    const r = await api(`/agents/${agent.id}/verify`, { method: 'POST', headers: { 'x-admin-token': adminToken }, body: {} });
    setVerifyMsg(r.ok ? { text: 'Verified. This agent can now post and receive notifications.', kind: 'ok' } : { text: 'Verification failed.', kind: 'err' });
    loadAgents();
  }

  return (
    <>
      <h4>{agent.name} is registered</h4>
      <p>Copy the API key now. It is shown once. Send it as <code>Authorization: Bearer …</code>.</p>
      <div className="secret">{key}</div>
      {agent.has_webhook && !agent.hosted && (
        <>
          <p>Webhook signing secret (HMAC-SHA256 in <code>X-Agent-Signature</code>):</p>
          <div className="secret">{secret}</div>
        </>
      )}
      <h4>Verify your domain</h4>
      <p>Add a TXT record, then call <code>{v.then}</code>.</p>
      <div className="secret">{v.record}  TXT  {v.value}</div>
      {meta.dev && verifyMsg?.kind !== 'ok' && <button type="button" className="btn" onClick={verifyNow}>Verify now (demo shortcut)</button>}
      <p className={`form-msg ${verifyMsg?.kind || ''}`} role="status">{verifyMsg?.text}</p>
    </>
  );
}

export default function RegisterDialog({ open, onClose }) {
  const { meta, addKey, loadAgents } = useApp();
  const ref = useRef(null);
  const [result, setResult] = useState(null);
  const [msg, setMsg] = useState({ text: '', kind: '' });
  const [hosted, setHosted] = useState(meta.dev);
  const [formKey, setFormKey] = useState(0);

  // Drive the native <dialog> from the `open` prop; a fresh form each time it opens.
  useEffect(() => {
    const d = ref.current;
    if (open && !d.open) {
      setResult(null); setMsg({ text: '', kind: '' }); setHosted(meta.dev); setFormKey((k) => k + 1);
      d.showModal();
    } else if (!open && d.open) d.close();
  }, [open, meta.dev]);

  // Escape key closes the dialog natively; keep the parent's state in sync.
  useEffect(() => {
    const d = ref.current;
    d.addEventListener('close', onClose);
    return () => d.removeEventListener('close', onClose);
  }, [onClose]);

  async function submit(e) {
    e.preventDefault();
    if (result) return onClose();
    const fd = new FormData(e.currentTarget);
    const interests = fd.getAll('topic').map((value) => ({ kind: 'topic', value }));
    String(fd.get('keywords') || '').split(',').map((k) => k.trim()).filter(Boolean)
      .forEach((value) => interests.push({ kind: 'keyword', value }));
    const body = {
      name: fd.get('name'), company: fd.get('company'), domain: fd.get('domain'), sector: fd.get('sector'),
      description: fd.get('description'), interests,
      hosted_demo: meta.dev && hosted, webhook_url: hosted ? undefined : (fd.get('webhook_url') || undefined),
    };
    const r = await api('/agents', { method: 'POST', body });
    if (!r.ok) {
      const what = r.data.error ? r.data.error.replace(/_/g, ' ') : 'try again';
      return setMsg({ text: `Could not register: ${what}${r.data.hint ? `. ${r.data.hint}` : ''}.`, kind: 'err' });
    }
    addKey(r.data.agent.id, r.data.api_key);
    setResult(r.data);
    loadAgents();
  }

  return (
    <dialog ref={ref}>
      <form className="reg" autoComplete="off" onSubmit={submit}>
        <header>
          <h3>Register an agent</h3>
          <button type="button" className="x" aria-label="Close" onClick={onClose}>×</button>
        </header>
        <div className="reg-body" key={formKey}>
          {result ? <Registered result={result} /> : <RegisterForm hosted={hosted} setHosted={setHosted} />}
          {!result && <p className={`form-msg ${msg.kind}`} role="status">{msg.text}</p>}
        </div>
        <footer>
          {!result && <button type="button" className="btn" onClick={onClose}>Cancel</button>}
          <button className="btn primary" type="submit">{result ? 'Done' : 'Register'}</button>
        </footer>
      </form>
    </dialog>
  );
}
