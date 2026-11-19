import { useCallback, useEffect, useState } from 'react';
import { api, messageOf } from '../api.js';
import { locale, t } from '../i18n.js';
import { useControl } from '../hooks/useCountdown.js';
import { Restart } from '../components/Icons.jsx';

function windowName(limit) {
  const extra = limit.kind.startsWith('weekly_') && limit.kind !== 'weekly_all' ? limit.kind.slice(7) : '';
  let name;
  if (limit.windowMins === 10080) name = t('usage.weekly');
  else if (limit.windowMins) name = t('usage.hours', { hours: Math.round(limit.windowMins / 60) });
  else name = limit.kind;
  return extra ? `${name} · ${extra}` : name;
}

/** "2 d 5 h", "3 h 12 min", "4 min": precise enough for a limit, short enough for a phone. */
function left(ms) {
  const min = Math.max(1, Math.ceil(ms / 60_000));
  const d = Math.floor(min / 1440);
  const h = Math.floor((min % 1440) / 60);
  const m = min % 60;
  if (d) return t('usage.leftDays', { d, h });
  if (h) return t('usage.leftHours', { h, m });
  return t('usage.leftMinutes', { m });
}

function resets(ms, now) {
  if (!ms) return '';
  const when = new Date(ms).toLocaleString(locale(), {
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
  if (ms <= now) return t('usage.resetNow');
  return t('usage.resetsIn', { left: left(ms - now), when });
}

/** The current time, moving every 30 seconds, for the countdowns. */
function useNow() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function Bar({ percent, label, sub }) {
  const p = Math.max(0, Math.min(100, Math.round(percent)));
  const level = p >= 90 ? 'high' : p >= 70 ? 'mid' : '';
  return (
    <div className="usage-row">
      <div className="usage-row-head">
        <span>{label}</span>
        <span className="mono">{p}%</span>
      </div>
      <div
        className={`usage-bar ${level}`}
        role="progressbar"
        aria-valuenow={p}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <span style={{ width: `${p}%` }} />
      </div>
      {sub && <span className="muted small">{sub}</span>}
    </div>
  );
}

function AgentUsage({ agent, control, tick, now }) {
  const [state, setState] = useState({ tick: -1, account: null, error: null });
  const limited = agent.type === 'claude' || agent.type === 'codex';

  useEffect(() => {
    if (!limited || !control) return undefined;
    let alive = true;
    api(`/api/agents/${encodeURIComponent(agent.id)}/usage${tick ? '?fresh=1' : ''}`).then(
      (r) => alive && setState({ tick, account: r.account, error: null }),
      (error) => alive && setState({ tick, account: null, error }),
    );
    return () => {
      alive = false;
    };
  }, [agent.id, limited, control, tick]);

  const loading = state.tick !== tick;
  const plan = state.account?.plan ?? agent.plan;
  const fill = agent.context?.size ? (agent.context.used / agent.context.size) * 100 : null;

  return (
    <section className="card stack-sm usage-card">
      <div className="usage-head">
        <h3>{agent.name}</h3>
        {plan && <span className="pill">{plan}</span>}
      </div>
      {limited && !control && <p className="muted small">{t('viewModeHint')}</p>}
      {limited && control && loading && !state.account && <p className="muted small">{t('usage.loading')}</p>}
      {state.error && <p className="error small">{messageOf(state.error)}</p>}
      {state.account?.limits.map((l) => (
        <Bar key={l.kind} percent={l.percent} label={windowName(l)} sub={resets(l.resetsAt, now)} />
      ))}
      {limited && state.account && !state.account.limits.length && (
        <p className="muted small">{t('usage.noLimits')}</p>
      )}
      {!limited && <p className="muted small">{t('usage.noAccount')}</p>}
      {agent.pid !== null && (agent.model || fill !== null) && (
        <div className="stack-sm usage-session">
          {agent.model && (
            <span className="small">
              {t('usage.model')}: <span className="mono">{agent.model}</span>
            </span>
          )}
          {fill !== null && (
            <Bar
              percent={fill}
              label={t('usage.contextLabel')}
              sub={t('usage.contextHint', {
                used: agent.context.used.toLocaleString(),
                size: agent.context.size.toLocaleString(),
              })}
            />
          )}
        </div>
      )}
    </section>
  );
}

export default function Usage({ agents, conn }) {
  const { control } = useControl(conn.mode);
  const [tick, setTick] = useState(0);
  const now = useNow();
  const refresh = useCallback(() => setTick((n) => n + 1), []);
  const chats = agents.filter((a) => a.type !== 'terminal');

  return (
    <main className="page stack">
      <div className="usage-title">
        <h1 className="hero small-hero">{t('usage.title')}</h1>
        <button className="btn" onClick={refresh} disabled={!control} title={t('usage.refresh')}>
          <Restart size={15} /> <span className="btn-label">{t('usage.refresh')}</span>
        </button>
      </div>
      <p className="muted small">{t('usage.hint')}</p>
      {chats.map((a) => (
        <AgentUsage key={a.id} agent={a} control={control} tick={tick} now={now} />
      ))}
    </main>
  );
}
