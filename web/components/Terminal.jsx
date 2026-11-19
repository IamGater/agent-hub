import { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';

// Agent output is only ever rendered by xterm.js, never as HTML.
export default function Terminal({ agentId, listen, send, control, focus }) {
  const el = useRef(null);
  const term = useRef(null);

  useEffect(() => {
    const t = new XTerm({
      fontSize: window.matchMedia('(min-width: 900px)').matches ? 14 : 13,
      fontFamily: "'Cascadia Mono', ui-monospace, Menlo, Consolas, monospace",
      lineHeight: 1.15,
      scrollback: 5000,
      disableStdin: true,
      // Agent TUIs assume a dark terminal, so it stays dark in the light theme too.
      theme: {
        background: '#1f1e1d',
        foreground: '#e8e6dc',
        cursor: '#d97757',
        selectionBackground: '#4a4842',
      },
    });
    const fit = new FitAddon();
    t.loadAddon(fit);
    t.loadAddon(
      new WebLinksAddon((_event, uri) => {
        if (/^https?:\/\//i.test(uri)) window.open(uri, '_blank', 'noopener,noreferrer');
      }),
    );
    t.open(el.current);
    fit.fit();
    term.current = t;

    const off = listen(agentId, (msg) => {
      if (msg.type === 'snapshot') t.reset();
      t.write(msg.data);
    });
    const ro = new ResizeObserver(() => fit.fit());
    ro.observe(el.current);
    return () => {
      off();
      ro.disconnect();
      t.dispose();
      term.current = null;
    };
  }, [agentId, listen]);

  useEffect(() => {
    const t = term.current;
    if (!t) return undefined;
    t.options.disableStdin = !control;
    if (!control) return undefined;
    const data = t.onData((d) => send({ type: 'input', agentId, data: d }));
    const resize = t.onResize(({ cols, rows }) => send({ type: 'resize', agentId, cols, rows }));
    send({ type: 'resize', agentId, cols: t.cols, rows: t.rows });
    return () => {
      data.dispose();
      resize.dispose();
    };
  }, [control, agentId, send]);

  // At the computer the keyboard goes straight into the terminal, like a normal console.
  useEffect(() => {
    if (focus && control) term.current?.focus();
  }, [focus, control]);

  return <div className="terminal" ref={el} />;
}
