import { useSyncExternalStore } from 'react';

// How the chat looks is a matter of taste per device, so it lives in localStorage like the language.
// Without storage the choice lasts until the page reloads.

const KEY = 'tools';
/** @type {readonly ['separate', 'grouped']} */
export const TOOL_VIEWS = ['separate', 'grouped'];

function stored() {
  try {
    const v = localStorage.getItem(KEY);
    return TOOL_VIEWS.includes(v) ? v : 'separate';
  } catch {
    return 'separate';
  }
}

let toolView = stored();
const subscribers = new Set();

export function setToolView(next) {
  if (!TOOL_VIEWS.includes(next) || next === toolView) return;
  toolView = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    // Kept in memory only.
  }
  for (const fn of subscribers) fn();
}

/** 'separate': every command is its own row; 'grouped': commands in a row fold into one. */
export function useToolView() {
  return useSyncExternalStore(
    (fn) => {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
    () => toolView,
  );
}
