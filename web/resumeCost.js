import { t } from './i18n.js';

/** From this size resuming asks first: the next message sends the whole conversation again. */
const LONG_TOKENS = 50_000;
const LONG_PERCENT = 2;

/** 950 -> "950", 12_345 -> "12k", 2_400_000 -> "2.4M". */
function short(n) {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** 0.3 -> "<1", 4.26 -> "4.3", 37.8 -> "38". */
export function percentText(p) {
  if (p < 1) return '<1';
  return p < 10 ? String(Math.round(p * 10) / 10) : String(Math.round(p));
}

/** A short note for the session list: "180k tokens · ≈6%". */
export function costLabel(session) {
  if (!session.tokens) return '';
  const tokens = t('resume.tokens', { tokens: short(session.tokens) });
  return session.percent === null || session.percent === undefined
    ? tokens
    : `${tokens} · ≈${percentText(session.percent)}%`;
}

/** The warning to confirm before resuming a long session, or null for a short one. */
export function resumeWarning(session) {
  if (!session?.tokens) return null;
  const known = typeof session.percent === 'number';
  if (session.tokens < LONG_TOKENS && !(known && session.percent >= LONG_PERCENT)) return null;
  const vars = { tokens: short(session.tokens), percent: known ? percentText(session.percent) : '' };
  const main = known ? t('resume.costPercent', vars) : t('resume.costTokens', vars);
  return session.warm ? `${main} ${t('resume.warm')}` : main;
}
