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
export function useNow() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** Blue while there is room, yellow from 75%, red from 90%. */
export function levelOf(percent) {
  return percent >= 90 ? 'high' : percent >= 75 ? 'mid' : 'low';
}

/** "just now", "5 min ago", "2 h ago": how old the shown limits are. */
function ago(at, now) {
  const min = Math.floor(Math.max(0, now - at) / 60_000);
  if (min < 1) return t('usage.justNow');
  if (min < 60) return t('usage.minAgo', { m: min });
  return t('usage.hoursAgo', { h: Math.floor(min / 60) });
}

/**
 * Plan limits of one agent. The last known ones (kept by the server) show at once; asking the
 * account takes a few seconds, and its answer replaces them when it comes.
 */
export function useAgentUsage(agent, control, tick) {
  const limited = agent.type === 'claude' || agent.type === 'codex';
  const [state, setState] = useState({ key: '', account: null, at: null, error: null, fresh: false });
  const key = `${agent.id}:${tick}:${control}`;

  useEffect(() => {
    if (!limited) return undefined;
    let alive = true;
    const base = `/api/agents/${encodeURIComponent(agent.id)}/usage`;
    api(`${base}?cached=1`).then(
      (r) =>
        alive &&
        r.account &&
        setState((s) => (s.key === key && s.fresh ? s : { ...s, account: r.account, at: r.at })),
      () => {},
    );
    if (control) {
      api(`${base}${tick ? '?fresh=1' : ''}`).then(
        (r) =>
          alive && setState({ key, account: r.account, at: r.at ?? Date.now(), error: null, fresh: true }),
        (error) => alive && setState((s) => ({ ...s, key, error, fresh: true })),
      );
    }
    return () => {
      alive = false;
    };
  }, [agent.id, limited, control, tick, key]);

  const current = state.key === key;
  return {
    limited,
    account: state.account,
    at: state.at,
    error: current ? state.error : null,
    updating: limited && control && !(current && state.fresh),
  };
}

function Bar({ percent, label, sub }) {
  const p = Math.max(0, Math.min(100, Math.round(percent)));
  const level = levelOf(p);
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

export function AgentUsage({ agent, control, tick, now, bare = false }) {
  const usage = useAgentUsage(agent, control, tick);
  const { limited, account } = usage;
  const plan = account?.plan ?? agent.plan;
  const fill = agent.context?.size ? (agent.context.used / agent.context.size) * 100 : null;

  return (
    <section className={bare ? 'stack-sm' : 'card stack-sm usage-card'}>
      <div className="usage-head">
        <h3>{agent.name}</h3>
        {plan && <span className="pill">{plan}</span>}
      </div>
      {limited && !control && !account && <p className="muted small">{t('viewModeHint')}</p>}
      {usage.updating && !account && <p className="muted small">{t('usage.loading')}</p>}
      {account && usage.at && (
        <p className="muted small">
          {t('usage.updated', { ago: ago(usage.at, now) })}
          {usage.updating && ` · ${t('usage.updating')}`}
        </p>
      )}
      {usage.error && <p className="error small">{messageOf(usage.error)}</p>}
      {account?.limits.map((l) => (
        <Bar key={l.kind} percent={l.percent} label={windowName(l)} sub={resets(l.resetsAt, now)} />
      ))}
      {limited && account && !account.limits.length && <p className="muted small">{t('usage.noLimits')}</p>}
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
