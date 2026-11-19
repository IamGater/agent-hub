import { t } from '../i18n.js';
import { navigate } from '../hooks/useRoute.js';
import { NavLinks, RemoteSwitch } from './Controls.jsx';
import { BrandMark } from './Icons.jsx';
import StatusDot, { statusText } from './StatusDot.jsx';

export function folderName(p) {
  return p.split(/[\\/]/).filter(Boolean).at(-1) ?? p;
}

export function AgentList({ agents, selected = null }) {
  if (!agents.length) return <p className="muted small side-empty">{t('noAgentsShort')}</p>;
  return (
    <ul className="agent-list">
      {agents.map((a) => (
        <li key={a.id}>
          <button
            className={`agent-item ${a.id === selected ? 'active' : ''}`}
            onClick={() => navigate(`/agent/${encodeURIComponent(a.id)}`)}
          >
            <StatusDot status={a.status} />
            <span className="agent-item-text">
              <span className="agent-item-name">{a.name}</span>
              <span className="agent-item-sub">
                {folderName(a.cwd)} · {statusText(a)}
              </span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export default function Sidebar({ agents, route, state, onChange, online }) {
  return (
    <aside className="sidebar">
      <button className="brand" onClick={() => navigate('/')}>
        <BrandMark />
        Agent Hub
      </button>
      <div className="side-section">{t('agents')}</div>
      <div className="side-scroll">
        <AgentList agents={agents} selected={route.page === 'agent' ? route.arg : null} />
      </div>
      <div className="side-foot">
        {!online && <span className="pill warn">{t('offline')}</span>}
        <RemoteSwitch state={state} onChange={onChange} />
        <NavLinks state={state} onChange={onChange} route={route} />
      </div>
    </aside>
  );
}
