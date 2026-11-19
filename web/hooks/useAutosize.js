import { useLayoutEffect } from 'react';

/**
 * Grows a text box with its content up to the CSS max-height, after which it scrolls. CSS
 * `field-sizing: content` does this too, but Safari on iPhone does not support it.
 */
export function useAutosize(ref, value) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [ref, value]);
}
