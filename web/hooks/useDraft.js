import { useCallback, useState } from 'react';

// What is typed but not sent stays with its agent: going to another agent and back, or reloading
// the page, finds it again. Without storage it lasts while the page is open.
const memory = new Map();
const key = (id) => `draft:${id}`;

function load(id) {
  if (memory.has(id)) return memory.get(id);
  try {
    return localStorage.getItem(key(id)) ?? '';
  } catch {
    return '';
  }
}

function save(id, text) {
  if (text) memory.set(id, text);
  else memory.delete(id);
  try {
    if (text) localStorage.setItem(key(id), text);
    else localStorage.removeItem(key(id));
  } catch {
    // Kept in memory only.
  }
}

/** The message box text of one agent. @param {string} id */
export function useDraft(id) {
  const [state, setState] = useState(() => ({ id, text: load(id) }));
  let current = state;
  // The same box shown for another agent: take that agent's draft.
  if (state.id !== id) {
    current = { id, text: load(id) };
    setState(current);
  }
  const set = useCallback(
    (text) => {
      save(id, text);
      setState({ id, text });
    },
    [id],
  );
  return [current.text, set];
}
