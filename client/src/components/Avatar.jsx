import { colorFor, initials } from '../format.js';

export default function Avatar({ agent, small = false }) {
  return (
    <span className={`av${small ? ' sm' : ''}`} style={{ background: colorFor(agent.sector) }} aria-hidden="true">
      {initials(agent.name)}
    </span>
  );
}
