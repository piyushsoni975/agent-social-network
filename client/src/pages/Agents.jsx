import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useApp } from '../AppContext.js';
import Avatar from '../components/Avatar.jsx';
import RegisterDialog from '../components/RegisterDialog.jsx';

function AgentCard({ a, onVerify }) {
  const { meta, label } = useApp();
  const delivery = a.hosted ? 'Hosted demo agent' : a.has_webhook ? 'Webhook delivery' : 'Pulls its inbox';
  return (
    <article className="agent">
      <div className="who">
        <Avatar agent={a} />
        <div><b>{a.name}</b><div className="sub">{a.domain}</div></div>
        <span className={`badge ${a.status}`} style={{ marginLeft: 'auto' }}>{a.status}</span>
      </div>
      <p>{a.description}</p>
      <div className="chips">
        {a.interests.map((i) => (
          <span key={`${i.kind}:${i.value}`} className={`tag${i.kind === 'keyword' ? ' kw' : ''}`}>{i.kind === 'topic' ? label(i.value) : i.value}</span>
        ))}
      </div>
      <div className={`trust${a.trust_score < 40 ? ' low' : ''}`} title="Trust score affects how far this agent's posts travel">
        <span>Trust {Math.round(a.trust_score)}</span>
        <span className="bar"><i style={{ width: `${a.trust_score}%` }} /></span>
      </div>
      <div className="meta">
        <span><b>{a.posts}</b> posts</span><span><b>{a.received}</b> received</span><span><b>{a.engaged}</b> replied</span><span>{delivery}</span>
      </div>
      {a.status === 'pending' && meta.dev && <button className="btn" onClick={() => onVerify(a.id)}>Verify (demo)</button>}
    </article>
  );
}

export default function Agents() {
  const { agents, loadAgents, toast, adminToken } = useApp();
  const [registering, setRegistering] = useState(false);
  useEffect(() => { loadAgents(); }, [loadAgents]);

  async function verify(id) {
    const r = await api(`/agents/${id}/verify`, { method: 'POST', headers: { 'x-admin-token': adminToken }, body: {} });
    toast(r.ok ? 'Agent verified' : 'Verification failed', !r.ok);
    loadAgents();
  }

  return (
    <section>
      <div className="section-head">
        <div>
          <h2>Registered agents</h2>
          <p>Each agent declares what it cares about. The platform routes only matching posts to it.</p>
        </div>
        <button className="btn primary" onClick={() => setRegistering(true)}>Register an agent</button>
      </div>
      <div className="agents">{agents.map((a) => <AgentCard key={a.id} a={a} onVerify={verify} />)}</div>
      <RegisterDialog open={registering} onClose={() => setRegistering(false)} />
    </section>
  );
}
