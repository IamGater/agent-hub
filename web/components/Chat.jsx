import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ApiError, messageOf } from '../api.js';
import { has, locale, t } from '../i18n.js';
import Composer, { clock, useClock } from './Composer.jsx';
import Dropdown from './Dropdown.jsx';
import { Close, Copy, Forward } from './Icons.jsx';
import Markdown from './Markdown.jsx';

// The server keeps a bounded transcript; without the same bound here a long session would grow
// the window's memory forever. Oldest items go first, like on the server.
const MAX_ITEMS = 400;
const MAX_CHARS = 1_000_000;

function sizeOf(item) {
  return (item.text?.length ?? 0) + (item.detail?.length ?? 0) + (item.output?.length ?? 0) + 200;
}

function bounded(list) {
  let total = 0;
  let start = list.length;
  while (start > 0 && list.length - start < MAX_ITEMS) {
    total += sizeOf(list[start - 1]);
    if (total > MAX_CHARS && start < list.length) break;
    start -= 1;
  }
  return start === 0 ? list : list.slice(start);
}

/** Keeps the conversation and the command list of one chat agent in sync with the server. */
function useChat(agentId, listen) {
  const [items, setItems] = useState([]);
  const [commands, setCommands] = useState([]);
  useEffect(() => {
    return listen(agentId, (msg) => {
      if (msg.type === 'chat-snapshot') {
        setItems(bounded(msg.items));
      } else if (msg.type === 'chat-commands') {
        setCommands(msg.commands);
      } else if (msg.type === 'chat-item') {
        setItems((list) => {
          const i = list.findIndex((x) => x.id === msg.item.id);
          if (i < 0) return bounded([...list, msg.item]);
          const next = list.slice();
          next[i] = msg.item;
          return next;
        });
      } else if (msg.type === 'chat-delta') {
        setItems((list) => {
          const i = list.findLastIndex((x) => x.id === msg.itemId);
          if (i < 0) return list;
          const next = list.slice();
          next[i] = { ...list[i], text: (list[i].text ?? '') + msg.text };
          return i === list.length - 1 ? bounded(next) : next;
        });
      }
    });
  }, [agentId, listen]);
  return { items, commands };
}

/** Server notices carry a code so they show in the owner's language; unknown codes keep the text. */
function noticeText(item) {
  if (!item.code || !has(`notice.${item.code}`)) return item.text;
  const vars = { ...item.vars };
  // Times come as ISO strings and are shown in the owner's own clock.
  if (item.code === 'limit_wait' && vars.at) {
    const at = new Date(vars.at);
    if (!Number.isNaN(at.getTime())) {
      vars.at = at.toLocaleString(locale(), { weekday: 'short', hour: '2-digit', minute: '2-digit' });
    }
  }
  return t(`notice.${item.code}`, vars);
}

function Approval({ item, control, onAnswer }) {
  const pending = item.status === 'pending';
  const title = item.code && has(`approval.${item.code}`) ? t(`approval.${item.code}`) : item.title;
  return (
    <div className={`approval ${pending ? 'pending' : ''}`} aria-live={pending ? 'assertive' : undefined}>
      <div className="approval-head">
        <span className="approval-title">{pending ? t('chat.asks') : title}</span>
        {!pending && <span className="muted small">{t(`approval.${item.status}`)}</span>}
      </div>
      {pending && <div className="approval-what">{title}</div>}
      {pending && item.detail && <pre className="approval-detail">{item.detail}</pre>}
      {pending &&
        (control ? (
          <div className="approval-actions">
            <button className="btn primary" onClick={() => onAnswer(item.id, true)}>
              {t('chat.allow')}
            </button>
            <button className="btn" onClick={() => onAnswer(item.id, false)}>
              {t('chat.deny')}
            </button>
          </div>
        ) : (
          <p className="muted small">{t('unlockToAnswer')}</p>
        ))}
    </div>
  );
}

function Images({ agentId, item, onOpen }) {
  // A file being written is not there yet; show it once the tool is done.
  if (!item.images?.length || item.status === 'running') return null;
  return (
    <div className="images">
      {item.images.map((img) => {
        const src = `/api/agents/${encodeURIComponent(agentId)}/images/${img.id}?v=${item.ts}`;
        return (
          <button key={img.id} className="thumb" onClick={() => onOpen({ src, name: img.name })}>
            <img src={src} alt={t('chat.image', { name: img.name })} loading="lazy" />
            <span className="thumb-name">{img.name}</span>
          </button>
        );
      })}
    </div>
  );
}

function Tool({ agentId, item, onOpen }) {
  // Outputs run to 20k characters each; keep them out of the page until the owner opens one.
  const [open, setOpen] = useState(false);
  return (
    <div className="tool-wrap">
      <details className={`tool ${item.status ?? ''}`} onToggle={(e) => setOpen(e.currentTarget.open)}>
        <summary>
          <span className={`tool-dot ${item.status ?? ''}`} />
          <span className="tool-title">{item.title}</span>
          <span className="tool-status">{item.status ? t(`tool.${item.status}`) : ''}</span>
        </summary>
        {open && item.detail && <pre className="tool-pre">{item.detail}</pre>}
        {open && item.output && <pre className="tool-pre out">{item.output}</pre>}
      </details>
      <Images agentId={agentId} item={item} onOpen={onOpen} />
    </div>
  );
}

function MessageActions({ text, agent, agents, control, conn }) {
  const [copied, setCopied] = useState(false);
  const peers = agents.filter((a) => a.id !== agent.id && a.type !== 'terminal' && a.pid !== null);

  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <div className="msg-actions">
      <button
        className="msg-action"
        onClick={() =>
          navigator.clipboard?.writeText(text).then(
            () => setCopied(true),
            () => {},
          )
        }
      >
        <Copy size={14} /> {copied ? t('chat.copied') : t('chat.copy')}
      </button>
      {control && peers.length > 0 && (
        <Dropdown
          label={t('chat.sendTo')}
          value=""
          options={peers.map((p) => ({
            value: p.id,
            label: p.name,
            sub: p.busy ? t('status.answering') : '',
          }))}
          onChange={(to) =>
            conn.send({
              type: 'chat-send',
              agentId: to,
              text: `${t('chat.forwarded', { agent: agent.name })}\n\n${text}`.slice(0, 6000),
            })
          }
          trigger={
            <span className="msg-action">
              <Forward size={14} /> {t('chat.sendTo')}
            </span>
          }
        />
      )}
    </div>
  );
}

// Streaming changes one item many times a second; the others keep their identity and skip
// re-rendering (and re-parsing their Markdown).
const Item = memo(function Item({ item, agent, agents, control, conn, onAnswer, onOpen, onUnqueue }) {
  switch (item.kind) {
    case 'user':
      return (
        <div
          className={`msg user ${item.from ? 'relayed' : ''} ${item.status === 'pending' ? 'queued' : ''} ${item.status === 'cancelled' ? 'dropped' : ''}`}
        >
          {item.from && <span className="msg-from">{t('chat.from', { agent: item.from })}</span>}
          {item.text}
          {item.status === 'pending' && (
            <span className="msg-queue">
              {t('chat.queued')}
              {control && (
                <button className="msg-unqueue" onClick={() => onUnqueue(item.id)}>
                  {t('chat.unqueue')}
                </button>
              )}
            </span>
          )}
          {item.status === 'cancelled' && <span className="msg-queue">{t('chat.notSent')}</span>}
        </div>
      );
    case 'assistant':
      return item.text ? (
        <div className="msg assistant">
          <Markdown text={item.text} />
          <MessageActions text={item.text} agent={agent} agents={agents} control={control} conn={conn} />
        </div>
      ) : null;
    case 'tool':
      return <Tool agentId={agent.id} item={item} onOpen={onOpen} />;
    case 'approval':
      return <Approval item={item} control={control} onAnswer={onAnswer} />;
    default:
      return <div className={`notice ${item.level ?? ''}`}>{noticeText(item)}</div>;
  }
});

function Lightbox({ image, onClose }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="lightbox" role="dialog" aria-label={image.name} onClick={onClose}>
      <button className="icon-btn lightbox-close" aria-label={t('chat.close')} onClick={onClose}>
        <Close />
      </button>
      <img src={image.src} alt={t('chat.image', { name: image.name })} onClick={(e) => e.stopPropagation()} />
      <span className="lightbox-name">{image.name}</span>
    </div>
  );
}

/** The dots while the agent works, with how long this answer has taken so far. */
function Thinking({ since }) {
  const now = useClock(Boolean(since));
  return (
    <div className="thinking" aria-label={t('chat.working')}>
      <span />
      <span />
      <span />
      {since && <em className="thinking-time mono">{clock(now - since)}</em>}
    </div>
  );
}

export default function Chat({ agent, agents, conn, control, wide, blocked }) {
  const { items, commands } = useChat(agent.id, conn.listen);
  const scroller = useRef(null);
  const stick = useRef(true);
  const [dismissed, setDismissed] = useState(0);
  const [image, setImage] = useState(null);

  // Follow new output only while the owner is at the bottom, so scrolling up to read is not undone.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [items, agent.busy]);

  // The phone keyboard or a growing text box shrinks the chat; stay at the latest message.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return undefined;
    const keep = new ResizeObserver(() => {
      if (stick.current) el.scrollTop = el.scrollHeight;
    });
    keep.observe(el);
    return () => keep.disconnect();
  }, []);

  // Errors from the socket (agent busy, request gone) show for a few seconds under the input.
  const problem = conn.problem && conn.problem.at !== dismissed ? conn.problem : null;
  useEffect(() => {
    if (!problem) return undefined;
    const timer = setTimeout(() => setDismissed(problem.at), 6000);
    return () => clearTimeout(timer);
  }, [problem]);

  const send = (msg) => conn.send({ ...msg, agentId: agent.id });
  const connSend = conn.send;
  const agentId = agent.id;
  const onAnswer = useCallback(
    (requestId, allow) => connSend({ type: 'chat-answer', requestId, allow, agentId }),
    [connSend, agentId],
  );
  const onUnqueue = useCallback(
    (itemId) => connSend({ type: 'chat-unqueue', itemId, agentId }),
    [connSend, agentId],
  );

  // Esc stops the answer, like in Claude Code. Not while a picture is open or a menu took the key.
  const canStop = control && agent.busy;
  useEffect(() => {
    if (!canStop || image) return undefined;
    const onKey = (e) => {
      if (e.key !== 'Escape' || e.defaultPrevented || e.repeat) return;
      connSend({ type: 'chat-interrupt', agentId });
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [canStop, image, connSend, agentId]);

  return (
    <div className="chat">
      <div
        className="chat-scroll"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        <div className="chat-col">
          {!items.length && (
            <div className="chat-empty">
              <p className="hero small-hero">{agent.name}</p>
              <p className="muted">{agent.pid === null ? t('chat.emptyStopped') : t('chat.emptyRunning')}</p>
            </div>
          )}
          {items.map((item) => (
            <Item
              key={item.id}
              item={item}
              agent={agent}
              agents={agents}
              control={control}
              conn={conn}
              onOpen={setImage}
              onAnswer={onAnswer}
              onUnqueue={onUnqueue}
            />
          ))}
          {agent.busy && agent.status !== 'waiting' && <Thinking since={agent.busySince} />}
        </div>
      </div>
      <div className="chat-bottom">
        {problem && <p className="error small chat-error">{messageOf(new ApiError(problem.code))}</p>}
        <Composer
          blocked={blocked}
          agent={agent}
          control={control}
          wide={wide}
          commands={commands}
          onSend={(text) => {
            stick.current = true;
            send({ type: 'chat-send', text });
          }}
          onStop={() => send({ type: 'chat-interrupt' })}
        />
      </div>
      {image && <Lightbox image={image} onClose={() => setImage(null)} />}
    </div>
  );
}
