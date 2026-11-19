import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { locale } from '../i18n.js';

/**
 * Past sessions of a chat agent in a folder. Loaded only while `enabled`; listing starts the agent
 * binary briefly on the server, so it is not done on every render.
 */
export function useSessions(agentId, cwd, enabled) {
  const [state, setState] = useState({ key: '', list: null, error: null });
  const key = `${agentId}\n${cwd}`;

  useEffect(() => {
    if (!enabled) return undefined;
    let alive = true;
    api(`/api/agents/${encodeURIComponent(agentId)}/sessions?cwd=${encodeURIComponent(cwd)}`).then(
      (list) => alive && setState({ key, list, error: null }),
      (error) => alive && setState({ key, list: null, error }),
    );
    return () => {
      alive = false;
    };
  }, [agentId, cwd, key, enabled]);

  const fresh = state.key === key;
  return { list: fresh ? state.list : null, error: fresh ? state.error : null, loading: enabled && !fresh };
}

export function when(ms) {
  return ms ? new Date(ms).toLocaleString(locale(), { dateStyle: 'medium', timeStyle: 'short' }) : '';
}
