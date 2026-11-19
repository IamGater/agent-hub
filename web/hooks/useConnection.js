import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * One WebSocket for the whole app. Holds the agent list and the access mode as the server
 * reports them; terminals register listeners for their agent's output.
 */
export function useConnection(enabled, onUnauthorized) {
  const [agents, setAgents] = useState([]);
  const [mode, setMode] = useState({ mode: 'view', deadline: 0 });
  const [online, setOnline] = useState(false);
  const [problem, setProblem] = useState(null);
  const wsRef = useRef(null);
  const listeners = useRef(new Map());
  const unauthorized = useRef(onUnauthorized);

  useEffect(() => {
    unauthorized.current = onUnauthorized;
  }, [onUnauthorized]);

  useEffect(() => {
    if (!enabled) return undefined;
    let stopped = false;
    let retry = 0;
    let timer = null;

    function applyMode(msg) {
      let deadline = 0;
      if (msg.mode === 'control') deadline = msg.remainingMs === null ? null : Date.now() + msg.remainingMs;
      setMode({ mode: msg.mode, deadline });
    }

    function open() {
      const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
      wsRef.current = ws;
      ws.onopen = () => {
        retry = 0;
        setOnline(true);
        for (const id of listeners.current.keys())
          ws.send(JSON.stringify({ type: 'subscribe', agentId: id }));
      };
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'hello') {
          setAgents(msg.agents);
          applyMode(msg);
        } else if (msg.type === 'mode') {
          applyMode(msg);
        } else if (msg.type === 'agent') {
          setAgents((list) => list.map((a) => (a.id === msg.agent.id ? msg.agent : a)));
        } else if (msg.type === 'snapshot' || msg.type === 'output' || msg.type.startsWith('chat-')) {
          listeners.current.get(msg.agentId)?.(msg);
        } else if (msg.type === 'error') {
          if (msg.code === 'view_mode') setMode({ mode: 'view', deadline: 0 });
          setProblem({ code: msg.code, at: Date.now() });
        }
      };
      ws.onclose = (ev) => {
        setOnline(false);
        wsRef.current = null;
        if (stopped) return;
        if (ev.code === 4401 || ev.code === 1006) {
          // 1006 is also what a refused upgrade (expired cookie) looks like from the browser.
          unauthorized.current?.();
        }
        retry = Math.min(retry + 1, 6);
        timer = setTimeout(open, 500 * 2 ** retry);
      };
    }

    // A phone drops the socket in the background and the backoff may have grown to half a minute;
    // coming back to the app or getting the network back reconnects at once.
    function wake() {
      if (stopped || wsRef.current || document.visibilityState !== 'visible') return;
      clearTimeout(timer);
      retry = 0;
      open();
    }

    open();
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('online', wake);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('online', wake);
      wsRef.current?.close();
    };
  }, [enabled]);

  const send = useCallback((msg) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }, []);

  const listen = useCallback(
    (agentId, fn) => {
      listeners.current.set(agentId, fn);
      send({ type: 'subscribe', agentId });
      return () => {
        listeners.current.delete(agentId);
        send({ type: 'unsubscribe', agentId });
      };
    },
    [send],
  );

  const setControl = useCallback((remainingMs) => {
    setMode({ mode: 'control', deadline: Date.now() + remainingMs });
  }, []);

  return { agents, mode, online, problem, send, listen, setControl };
}
