import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { useFitInView } from '../hooks/useFitInView.js';
import { api, dangerous, messageOf } from '../api.js';
import { t } from '../i18n.js';
import { useAutosize } from '../hooks/useAutosize.js';
import { useControl } from '../hooks/useCountdown.js';
import { useSessions, when } from '../hooks/useSessions.js';
import Chat from '../components/Chat.jsx';
import ConfirmButton from '../components/ConfirmButton.jsx';
import { BlockedInput, ModeControl } from '../components/Controls.jsx';
import Dropdown from '../components/Dropdown.jsx';
import { ArrowUp, Folder, History, LinkIcon, Play, Restart, Stop } from '../components/Icons.jsx';
import KeyBar from '../components/KeyBar.jsx';
import PromptCard from '../components/PromptCard.jsx';
import StatusDot, { statusText } from '../components/StatusDot.jsx';

// xterm.js is only needed by terminal agents; chat-only setups never load it.
const Terminal = lazy(() => import('../components/Terminal.jsx'));

function ProjectPicker({ value, onChange, disabled }) {
  const [projects, setProjects] = useState([]);
  useEffect(() => {
    let alive = true;
    api('/api/projects').then(
      (list) => alive && setProjects(list),
      () => {},
    );
    return () => {
      alive = false;
    };
  }, []);
  const known = projects.some((p) => p.path.toLowerCase() === value.toLowerCase());
  const options = [
    ...(known ? [] : [{ value, label: value }]),
    ...projects.map((p) => ({
      value: p.path,
      label: p.name === p.path ? p.path : p.name,
      sub: p.name === p.path ? undefined : p.path,
    })),
  ];
  return (
    <Dropdown
      className="picker"
      label={t('projectFolder')}
      value={value}
      options={options}
      onChange={onChange}
      disabled={disabled}
      icon={<Folder size={16} />}
    />
  );
}

const HOPS = [2, 4, 6, 10, 20];

/** Lets the owner start a conversation between this chat agent and another running one. */
/** Past conversations in the chosen folder; picking one starts the agent on it. */
function ResumeControl({ agent, cwd, disabled, onResume }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef(null);
  const pop = useRef(null);
  const sessions = useSessions(agent.id, cwd, open);
  useFitInView(pop, open);

  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => {
      if (!anchor.current?.contains(e.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);

  return (
    <div className="popover-anchor" ref={anchor}>
      <button
        className={`btn ${open ? 'pressed' : ''}`}
        disabled={disabled}
        aria-expanded={open}
        title={t('resume.button')}
        onClick={() => setOpen(!open)}
      >
        <History size={15} />
        <span className="btn-label">{t('resume.button')}</span>
      </button>
      {open && (
        <div className="popover stack-sm" role="dialog" aria-label={t('resume.title')} ref={pop}>
          <strong>{t('resume.title')}</strong>
          {sessions.loading && <p className="muted small">{t('chat.sessionsLoading')}</p>}
          {sessions.error && <p className="error small">{messageOf(sessions.error)}</p>}
          {sessions.list && !sessions.list.length && <p className="muted small">{t('chat.noSessions')}</p>}
          {sessions.list?.length > 0 && (
            <ul className="session-list">
              {sessions.list.map((s) => (
                <li key={s.id}>
                  <button
                    onClick={() => {
                      setOpen(false);
                      onResume(s.id);
                    }}
                  >
                    <span className="session-title">{s.title}</span>
                    <span className="muted small">{when(s.updatedAt)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function LinkControl({ agent, agents, conn, control }) {
  const [open, setOpen] = useState(false);
  const peers = agents.filter((a) => a.id !== agent.id && a.type !== 'terminal' && a.pid !== null && !a.link);
  const [peer, setPeer] = useState('');
  const [hops, setHops] = useState(6);
  const chosen = peers.some((p) => p.id === peer) ? peer : (peers[0]?.id ?? '');
  const anchor = useRef(null);
  const pop = useRef(null);
  useFitInView(pop, open);

  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => {
      if (!anchor.current?.contains(e.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);

  if (agent.link) {
    const other = agents.find((a) => a.id === agent.link.peer);
    return (
      <span className="pill accent link-pill">
        <LinkIcon size={14} />
        {t('link.active', { agent: other?.name ?? agent.link.peer, left: agent.link.left })}
        {control && (
          <button className="pill-btn" onClick={() => conn.send({ type: 'chat-unlink', agentId: agent.id })}>
            {t('link.stop')}
          </button>
        )}
      </span>
    );
  }

  return (
    <div className="popover-anchor" ref={anchor}>
      <button
        className={`btn ${open ? 'pressed' : ''}`}
        disabled={!control}
        aria-expanded={open}
        title={t('link.button')}
        onClick={() => setOpen(!open)}
      >
        <LinkIcon size={15} />
        <span className="btn-label">{t('link.button')}</span>
      </button>
      {open && (
        <div className="popover stack-sm" role="dialog" aria-label={t('link.title')} ref={pop}>
          <strong>{t('link.title')}</strong>
          <p className="muted small">{t('link.hint')}</p>
          {peers.length ? (
            <>
              <label className="field-row">
                <span>{t('link.peer')}</span>
                <Dropdown
                  label={t('link.peer')}
                  value={chosen}
                  options={peers.map((p) => ({ value: p.id, label: p.name }))}
                  onChange={setPeer}
                />
              </label>
              <label className="field-row">
                <span>{t('link.hops')}</span>
                <Dropdown
                  label={t('link.hops')}
                  value={hops}
                  options={HOPS.map((n) => ({ value: n, label: String(n) }))}
                  onChange={setHops}
                />
              </label>
              <button
                className="btn primary"
                onClick={() => {
                  conn.send({ type: 'chat-link', agentId: agent.id, peer: chosen, hops });
                  setOpen(false);
                }}
              >
                {t('link.start')}
              </button>
            </>
          ) : (
            <p className="small">{t('link.noPeers')}</p>
          )}
        </div>
      )}
    </div>
  );
}

// Chat-style composer for the phone: there is no physical keyboard to type into the terminal.
function Composer({ control, running, onKey }) {
  const [text, setText] = useState('');
  const input = useRef(null);
  useAutosize(input, text);
  const enabled = control && running;

  function send(e) {
    e?.preventDefault();
    if (!text || !enabled) return;
    onKey(text);
    onKey('\r');
    setText('');
  }

  return (
    <form className="composer" onSubmit={send}>
      <textarea
        ref={input}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={!running ? t('agentNotRunning') : control ? t('replyAgent') : t('viewModeHint')}
        disabled={!enabled}
        maxLength={4000}
        rows={1}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
      />
      <KeyBar onKey={onKey} disabled={!enabled} />
      <button className="send" aria-label={t('send')} disabled={!enabled || !text}>
        <ArrowUp />
      </button>
    </form>
  );
}

export default function Agent({ agent, agents, conn, wide }) {
  const [cwd, setCwd] = useState(agent.cwd);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const { control } = useControl(conn.mode);
  const running = agent.pid !== null;
  const chat = agent.type !== 'terminal';

  function start() {
    return act(() => api(`/api/agents/${encodeURIComponent(agent.id)}/start`, { cwd }));
  }

  function key(data) {
    conn.send({ type: 'input', agentId: agent.id, data });
  }

  async function act(fn) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className={`agent ${chat ? 'is-chat' : ''}`}>
      <header className="agent-head">
        <div className="agent-title">
          {wide && <h2>{agent.name}</h2>}
          <span className={`pill status ${agent.status}`}>
            <StatusDot status={agent.status} />
            {statusText(agent)}
            {agent.exitCode !== null && ` · ${t('status.code', { code: agent.exitCode })}`}
          </span>
          {agent.autoApprove && (
            <span className="pill warn" title={t('perm.autoHint')}>
              {t('perm.autoPill')}
            </span>
          )}
          {running && (
            <span className="muted small mono agent-cwd" title={agent.cwd}>
              {agent.cwd}
            </span>
          )}
        </div>
        <div className="agent-actions">
          {wide && <ModeControl conn={conn} />}
          {!running && <ProjectPicker value={cwd} onChange={setCwd} disabled={busy} />}
          {!running && chat && (
            <ResumeControl
              agent={agent}
              cwd={cwd}
              disabled={busy || !control}
              onResume={(resume) =>
                act(() => api(`/api/agents/${encodeURIComponent(agent.id)}/start`, { cwd, resume }))
              }
            />
          )}
          {!running && (
            <button className="btn primary" disabled={busy || !control} onClick={start}>
              <Play size={15} /> {t('start')}
            </button>
          )}
          {running && chat && <LinkControl agent={agent} agents={agents} conn={conn} control={control} />}
          {running && (
            <ConfirmButton
              className="btn"
              disabled={busy}
              armedLabel={t('restartArmed')}
              onConfirm={() => act(() => dangerous({ type: 'restart', agentId: agent.id }))}
            >
              <Restart size={15} />
              <span className="btn-label">{t('restart')}</span>
            </ConfirmButton>
          )}
          {running && (
            <ConfirmButton
              className="btn"
              disabled={busy}
              armedLabel={t('stopArmed')}
              onConfirm={() => act(() => dangerous({ type: 'stop', agentId: agent.id }))}
            >
              <Stop size={15} />
              <span className="btn-label">{t('stop')}</span>
            </ConfirmButton>
          )}
        </div>
        {!running && !control && <p className="muted small">{t('needControl')}</p>}
        {error && <p className="error small">{messageOf(error)}</p>}
      </header>

      {chat ? (
        <Chat
          agent={agent}
          agents={agents}
          conn={conn}
          control={control}
          wide={wide}
          blocked={
            <BlockedInput conn={conn} control={control} running={running} onStart={start} starting={busy} />
          }
        />
      ) : (
        <>
          {agent.status === 'waiting' && agent.prompt && (
            <PromptCard agent={agent} control={control} onKey={key} />
          )}

          <div className="term-card">
            <Suspense fallback={null}>
              <Terminal
                agentId={agent.id}
                listen={conn.listen}
                send={conn.send}
                control={control}
                focus={wide && running}
              />
            </Suspense>
          </div>

          {!wide &&
            (control && running ? (
              <Composer control={control} running={running} onKey={key} />
            ) : (
              <BlockedInput conn={conn} control={control} running={running} onStart={start} starting={busy} />
            ))}
        </>
      )}
    </main>
  );
}
