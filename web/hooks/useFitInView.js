import { useLayoutEffect } from 'react';

const GUTTER = 8;

/** The box the popup is cut to: the nearest ancestor that clips its overflow, or the window. */
function clipBox(el) {
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    const { overflowX } = getComputedStyle(p);
    if (overflowX !== 'visible') {
      const r = p.getBoundingClientRect();
      return { left: Math.max(0, r.left), right: Math.min(document.documentElement.clientWidth, r.right) };
    }
  }
  return { left: 0, right: document.documentElement.clientWidth };
}

/**
 * Shifts an open popup sideways so it stays visible. CSS anchors it to its button, which may sit
 * anywhere in a wrapped toolbar; the page area scrolls (and so clips), so the popup must fit in
 * that area, not just on screen. Where it ends up is only known after layout.
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
    const box = clipBox(el);
    let dx = 0;
    if (left < box.left + GUTTER) dx = box.left + GUTTER - left;
    else if (right > box.right - GUTTER) dx = Math.max(box.left + GUTTER - left, box.right - GUTTER - right);
    // `translate` is separate from `transform`, which the opening animation uses.
    if (dx) el.style.setProperty('translate', `${Math.round(dx)}px 0`);
  }, [ref, open]);
}
