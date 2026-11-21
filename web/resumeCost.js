import { t } from './i18n.js';

/** From this size resuming asks first: the next message sends the whole conversation again. */
const LONG_TOKENS = 50_000;

/** 950 -> "950", 12_345 -> "12k", 2_400_000 -> "2.4M". */
function short(n) {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** A short note for the session list: "180k tokens". */
export function costLabel(session) {
  if (!session.tokens) return '';
  return t('resume.tokens', { tokens: short(session.tokens) });
}

/** The warning to confirm before resuming a long session, or null for a short one. */
export function resumeWarning(session) {
  if (!session?.tokens) return null;
  if (session.tokens < LONG_TOKENS) return null;
  const main = t('resume.costTokens', { tokens: short(session.tokens) });
  return session.warm ? `${main} ${t('resume.warm')}` : main;
}
