import { useState } from 'react';
import { t } from '../i18n.js';
import { navigate } from '../hooks/useRoute.js';
import { NavLinks, RemoteSwitch } from './Controls.jsx';
import { BrandMark, PanelLeft } from './Icons.jsx';
import StatusDot, { statusText } from './StatusDot.jsx';

export function folderName(p) {
  return p.split(/[\\/]/).filter(Boolean).at(-1) ?? p;
}

/** "Claude Code A" -> "CA", "Claude Code" -> "CC", "Codex" -> "Co": tells agents apart in the rail. */
export function initials(name) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length < 2) return (words[0] ?? '?').slice(0, 2);
  return (words[0][0] + words.at(-1)[0]).toUpperCase();
}

// Per device, like the language: only a convenience, so a missing storage just means expanded.
function readCollapsed() {
  try {
    return localStorage.getItem('sidebar') === 'collapsed';
  } catch {
    return false;
  }
}

function writeCollapsed(on) {
  try {
    if (on) localStorage.setItem('sidebar', 'collapsed');
    else localStorage.removeItem('sidebar');
  } catch {
    // Not remembered; the toggle still works for this window.
  }
}

export function AgentList({ agents, selected = null }) {
  if (!agents.length) return <p className="muted small side-empty">{t('noAgentsShort')}</p>;
  return (
    <ul className="agent-list">
      {agents.map((a) => (
        <li key={a.id}>
          <button
            className={`agent-item ${a.id === selected ? 'active' : ''}`}
            title={`${a.name} · ${statusText(a)}`}
            onClick={() => navigate(`/agent/${encodeURIComponent(a.id)}`)}
          >
            <StatusDot status={a.status} />
            <span className="agent-initials" aria-hidden="true">
              {initials(a.name)}
            </span>
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
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const toggle = () => {
    writeCollapsed(!collapsed);
    setCollapsed(!collapsed);
  };
  const toggleLabel = collapsed ? t('side.expand') : t('side.collapse');

  return (
    <aside className={`sidebar ${collapsed ? 'collapsed' : ''}`}>
      <div className="side-head">
        <button className="brand" title="Agent Hub" onClick={() => navigate('/')}>
          <BrandMark />
          <span className="brand-name">Agent Hub</span>
        </button>
        <button
          className="icon-btn side-toggle"
          aria-label={toggleLabel}
          title={toggleLabel}
          onClick={toggle}
        >
          <PanelLeft size={17} />
        </button>
      </div>
      <div className="side-section">{t('agents')}</div>
      <div className="side-scroll">
        <AgentList agents={agents} selected={route.page === 'agent' ? route.arg : null} />
      </div>
      <div className="side-foot">
        {!online && (
          <span className="pill warn" title={t('offline')}>
            {collapsed ? '!' : t('offline')}
          </span>
        )}
        <RemoteSwitch state={state} onChange={onChange} compact={collapsed} />
        <NavLinks state={state} onChange={onChange} route={route} />
      </div>
    </aside>
  );
}
