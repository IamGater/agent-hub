import { useLayoutEffect } from 'react';

const GUTTER = 8;

/**
 * Shifts an open popup sideways so it stays on screen. CSS anchors it to its button, which on a
 * phone may sit anywhere in a wrapped toolbar, so where it ends up is only known after layout.
 */
export function useFitInView(ref, open) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!open || !el) return;
    el.style.removeProperty('translate');
    // Offsets ignore transforms; the bounding box would be shrunk by the opening animation's scale.
    const parent = el.offsetParent?.getBoundingClientRect() ?? { left: 0 };
    const left = parent.left + el.offsetLeft;
    const right = left + el.offsetWidth;
    const room = document.documentElement.clientWidth;
    let dx = 0;
    if (left < GUTTER) dx = GUTTER - left;
    else if (right > room - GUTTER) dx = Math.max(GUTTER - left, room - GUTTER - right);
    // `translate` is separate from `transform`, which the opening animation uses.
    if (dx) el.style.setProperty('translate', `${Math.round(dx)}px 0`);
  }, [ref, open]);
}
