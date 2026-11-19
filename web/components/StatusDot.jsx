import { t } from '../i18n.js';

/** Chat agents can say more than a terminal: whether they are answering or waiting for you. */
export function statusText(a) {
  if (a.type === 'terminal' || a.type === undefined) return t(`status.${a.status}`);
  if (a.status === 'waiting') return t('status.asking');
  if (a.status === 'running') return t(a.busy ? 'status.answering' : 'status.ready');
  return t(`status.${a.status}`);
}

export default function StatusDot({ status }) {
  return <span className={`dot ${status}`} aria-label={t(`status.${status}`)} />;
}
