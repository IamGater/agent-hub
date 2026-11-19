import { useEffect, useState } from 'react';

export function useCountdown(deadline) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!deadline) return undefined;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [deadline]);
  return Math.max(0, deadline - now);
}

/** A null deadline in control mode means unlimited (a session on the computer itself). */
export function useControl(mode) {
  const left = useCountdown(mode.deadline ?? 0);
  const unlimited = mode.mode === 'control' && mode.deadline === null;
  return { control: unlimited || (mode.mode === 'control' && left > 0), left, unlimited };
}

export function formatMs(ms) {
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
