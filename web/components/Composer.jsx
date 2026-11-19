import { useEffect, useRef, useState } from 'react';
import { messageOf } from '../api.js';
import { has, t } from '../i18n.js';
import { useAutosize } from '../hooks/useAutosize.js';
import { useSessions, when } from '../hooks/useSessions.js';
import { ArrowUp, Gauge, Stop } from './Icons.jsx';
import { AgentUsage, useNow } from '../pages/Usage.jsx';

/** 950 -> "950", 12_345 -> "12.3k", 2_400_000 -> "2.4M". */
export function compact(n) {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** 42_000 -> "0:42", 3_725_000 -> "1:02:05". */
export function clock(ms) {
  const sec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = String(sec % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** The current time, moving every second while `on`, for running clocks. */
export function useClock(on) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return undefined;
    const tick = () => setNow(Date.now());
    const timer = setInterval(tick, 1000);
    const first = setTimeout(tick, 0);
    return () => {
      clearInterval(timer);
      clearTimeout(first);
    };
  }, [on]);
  return now;
}

/** The account's limits for this agent, opened from the button under the message box. */
function UsagePopover({ agent, control, onClose }) {
  const box = useRef(null);
  const now = useNow();
  useEffect(() => {
    const away = (e) => {
      if (!box.current?.contains(e.target) && !e.target.closest?.('.usage-toggle')) onClose();
    };
    // Capture: Esc closes this first, and the chat does not take it as "stop".
    const key = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      onClose();
    };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', key, true);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', key, true);
    };
  }, [onClose]);
  return (
    <div className="usage-pop" ref={box}>
      <AgentUsage agent={agent} control={control} tick={0} now={now} bare />
    </div>
  );
}

/** "<low|medium|high>" or "[on|off]" lists the values the argument can take. */
function hintChoices(hint) {
  const m = /^[<[]([\w.-]+(?:\|[\w.-]+)+)[>\]]$/.exec(hint ?? '');
  return m ? m[1].split('|').map((v) => ({ value: v, label: v })) : null;
}

/** Where the owner is in typing a command: its name, or its argument. */
function stageOf(text) {
  const name = /^\/([\w:.-]*)$/.exec(text);
  if (name) return { kind: 'name', q: name[1].toLowerCase() };
  const arg = /^\/([\w:.-]+)[ \t]+([^\n]*)$/.exec(text);
  if (arg) return { kind: 'arg', name: arg[1], q: arg[2].trim().toLowerCase() };
  return null;
}

function describe(agent, c) {
  return agent.type === 'codex' && has(`codexcmd.${c.name}`) ? t(`codexcmd.${c.name}`) : c.description;
}

export default function Composer({ agent, control, wide, commands, onSend, onStop, blocked }) {
  const [text, setText] = useState('');
  const [active, setActive] = useState(0);
  const [closed, setClosed] = useState(false);
  const [usageOpen, setUsageOpen] = useState(false);
  const clockNow = useClock(agent.busy && Boolean(agent.busySince));
  const input = useRef(null);
  const list = useRef(null);
  useAutosize(input, text);
  const running = agent.pid !== null;
  // While the agent answers a message still goes: it waits in a queue for the answer to end.
  const enabled = control && running;

  const stage = enabled && !closed ? stageOf(text) : null;
  const command = stage?.kind === 'arg' ? commands.find((c) => c.name === stage.name) : null;
  const sessions = useSessions(agent.id, agent.cwd, command?.dynamic === 'sessions');

  // Rows: commands while the name is typed; values (models, levels, sessions) for the argument.
  let rows = null;
  let note = null;
  if (stage?.kind === 'name') {
    rows = commands
      .filter((c) => c.name.toLowerCase().startsWith(stage.q))
      .slice(0, 60)
      .map((c) => ({
        key: c.name,
        main: `/${c.name}`,
        hint: c.hint,
        sub: describe(agent, c),
        pick: () => `/${c.name} `,
      }));
  } else if (command) {
    let choices = command.options ?? hintChoices(command.hint);
    if (command.dynamic === 'sessions') {
      choices = sessions.list?.map((s) => ({ value: s.id, label: s.title, sub: when(s.updatedAt) })) ?? null;
      if (sessions.loading) note = t('chat.sessionsLoading');
      else if (sessions.error) note = messageOf(sessions.error);
      else if (!choices?.length) note = t('chat.noSessions');
    }
    if (choices) {
      rows = choices
        .filter(
          (o) =>
            !stage.q || o.value.toLowerCase().startsWith(stage.q) || o.label.toLowerCase().includes(stage.q),
        )
        .slice(0, 60)
        .map((o) => ({
          key: o.value,
          main: o.label,
          hint: o.label === o.value ? '' : o.value,
          sub: o.sub,
          final: true,
          pick: () => `/${command.name} ${o.value}`,
        }));
    } else if (!note && command.hint) {
      note = `/${command.name} ${command.hint}`;
    }
  }
  const shown = rows?.length ? rows : null;
  const current = shown ? Math.min(active, shown.length - 1) : 0;

  useEffect(() => {
    list.current?.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
  }, [current]);

  function submit(e) {
    e?.preventDefault();
    const value = text.trim();
    if (!value || !enabled) return;
    onSend(value);
    setText('');
    setClosed(false);
  }

  function choose(row) {
    setText(row.pick());
    setActive(0);
    // After a value the command is complete; after a name, its arguments are offered next.
    setClosed(Boolean(row.final));
    input.current?.focus();
  }

  function onKeyDown(e) {
    if (shown) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        return setActive((current + 1) % shown.length);
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        return setActive((current - 1 + shown.length) % shown.length);
      }
      if (e.key === 'Tab' || (wide && e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault();
        return choose(shown[current]);
      }
    }
    if (e.key === 'Escape') {
      // The first Esc closes the command list; with nothing open it stops the answer (see Chat).
      if (shown || note) {
        e.preventDefault();
        return setClosed(true);
      }
      return undefined;
    }
    // At the computer Enter sends, like in a chat; on the phone Enter is a new line.
    if (wide && e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) submit(e);
  }

  if (!control || !running) return <div className="composer-wrap">{blocked}</div>;

  // The agent reports model ids; the /model list knows their display names.
  const modelName = agent.model
    ? (commands.find((c) => c.name === 'model')?.options?.find((o) => o.value === agent.model)?.label ??
      agent.model)
    : null;
  const fill = agent.context?.size ? Math.round((agent.context.used / agent.context.size) * 100) : null;
  const tokens = agent.tokens;
  const limited = agent.type === 'claude' || agent.type === 'codex';

  let placeholder = t('chat.placeholder');
  if (!running) placeholder = t('agentNotRunning');
  else if (!control) placeholder = t('viewModeHint');
  else if (agent.busy) placeholder = t('chat.answeringQueue');

  return (
    <div className="composer-wrap">
      {(shown || note) && (
        <div className="commands">
          {note && <p className="cmd-note">{note}</p>}
          {shown && (
            <ul role="listbox" aria-label={t('chat.commands')} ref={list}>
              {shown.map((row, i) => (
                <li
                  key={row.key}
                  role="option"
                  aria-selected={i === current}
                  className={i === current ? 'active' : ''}
                  // A tap picks, a swipe scrolls: click fires only for a tap. Keeping focus in
                  // the text box (mousedown) leaves the phone keyboard open.
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => choose(row)}
                >
                  <span className="cmd-name">
                    {row.main}
                    {row.hint && <span className="cmd-hint"> {row.hint}</span>}
                  </span>
                  {row.sub && <span className="cmd-desc">{row.sub}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <form className="composer chat-composer" onSubmit={submit}>
        <textarea
          ref={input}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setClosed(false);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          disabled={!control || !running}
          maxLength={6000}
          rows={1}
          aria-autocomplete="list"
          aria-expanded={Boolean(shown)}
        />
        {agent.busy && control && !text.trim() ? (
          <button type="button" className="send stop" aria-label={t('chat.stop')} onClick={onStop}>
            <Stop size={16} />
          </button>
        ) : (
          <button className="send" aria-label={t('send')} disabled={!enabled || !text.trim()}>
            <ArrowUp />
          </button>
        )}
      </form>
      {usageOpen && <UsagePopover agent={agent} control={control} onClose={() => setUsageOpen(false)} />}
      <div className="composer-meta muted small">
        {limited && (
          <button
            type="button"
            className={`usage-toggle ${usageOpen ? 'on' : ''}`}
            aria-expanded={usageOpen}
            title={t('usage.title')}
            onClick={() => setUsageOpen((v) => !v)}
          >
            <Gauge size={13} /> {t('usage.title')}
          </button>
        )}
        {modelName && <span title={t('usage.model')}>{modelName}</span>}
        {fill !== null && (
          <span title={t('usage.contextHint', { used: agent.context.used, size: agent.context.size })}>
            {t('usage.context', { percent: fill })}
          </span>
        )}
        {tokens && (
          <span
            title={t('tokens.hint', {
              input: tokens.input.toLocaleString(),
              cached: tokens.cached.toLocaleString(),
              output: tokens.output.toLocaleString(),
            })}
          >
            {t('tokens.short', {
              input: compact(tokens.input + tokens.cached),
              output: compact(tokens.output),
            })}
          </span>
        )}
        {agent.busy && agent.busySince ? (
          <span className="mono" title={t('timer.running')}>
            ⏱ {clock(clockNow - agent.busySince)}
          </span>
        ) : (
          agent.lastTurnMs !== null &&
          agent.lastTurnMs !== undefined && (
            <span title={t('timer.lastHint')}>{t('timer.last', { time: clock(agent.lastTurnMs) })}</span>
          )
        )}
      </div>
    </div>
  );
}
