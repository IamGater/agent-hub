import { useState } from 'react';
import { api, dangerous, messageOf, stepup } from '../api.js';
import { t } from '../i18n.js';
import { formatMs, useControl } from '../hooks/useCountdown.js';
import { navigate } from '../hooks/useRoute.js';
import ConfirmButton from './ConfirmButton.jsx';
import { Gauge, Gear, Lock, Logout, Play, Power } from './Icons.jsx';

function useAction(onChange) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  async function run(fn) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
      onChange?.();
    }
  }
  return { busy, error: error ? messageOf(error) : '', run };
}

// Turning remote access on only works at the computer; turning it off is one tap from anywhere.
// Agents keep running either way.
export function RemoteSwitch({ state, onChange }) {
  const { busy, error, run } = useAction(onChange);
  const { scope, remote } = state;
  if (!remote.configured) return null;
  const off = () => run(() => api('/api/remote/off', {}));

  return (
    <div className="remote">
      <div className="remote-row">
        <span className="remote-label">
          {t('remoteAccess')}
          <span className={`remote-state ${remote.enabled ? 'on' : ''}`}>
            {remote.enabled ? t('remoteOn') : t('remoteOff')}
          </span>
        </span>
        {scope === 'local' ? (
          <button
            className={`toggle ${remote.enabled ? 'on' : ''}`}
            role="switch"
            aria-checked={remote.enabled}
            aria-label={t('remoteAccess')}
            disabled={busy}
            onClick={() => (remote.enabled ? off() : run(() => dangerous({ type: 'remote-on' })))}
          >
            <span />
          </button>
        ) : (
          <ConfirmButton className="btn small" disabled={busy} onConfirm={off} armedLabel={t('turnOffArmed')}>
            {t('turnOff')}
          </ConfirmButton>
        )}
      </div>
      {error && <p className="error small">{error}</p>}
    </div>
  );
}

// Phone sessions start in view mode; at the computer control is always on and nothing is shown.
/** Asks for the passkey and switches this phone session to control mode. */
async function unlock(conn) {
  const res = await stepup();
  conn.setControl(res.remainingMs);
  conn.send({ type: 'mode' });
}

/**
 * Stands where the message box is while it cannot be used, so the next step is under the thumb:
 * unlock input in view mode, start the agent when it is stopped.
 */
export function BlockedInput({ conn, control, running, onStart, starting }) {
  const { busy, error, run } = useAction();
  if (control && running) return null;
  return (
    <div className="blocked-input">
      {!control ? (
        <button className="btn primary wide-btn" disabled={busy} onClick={() => run(() => unlock(conn))}>
          <Lock size={16} /> {t('unlockInput')}
        </button>
      ) : (
        <button className="btn primary wide-btn" disabled={starting} onClick={onStart}>
          <Play size={16} /> {t('start')}
        </button>
      )}
      {error && <p className="error small">{error}</p>}
    </div>
  );
}

export function ModeControl({ conn }) {
  const { busy, error, run } = useAction();
  const { control, left, unlimited } = useControl(conn.mode);
  if (unlimited) return null;

  return (
    <span className="mode">
      {control ? (
        <span className="pill accent">{t('controlLeft', { time: formatMs(left) })}</span>
      ) : (
        <button className="btn small primary" disabled={busy} onClick={() => run(() => unlock(conn))}>
          <Lock size={15} /> {t('unlockInput')}
        </button>
      )}
      {error && <span className="error small">{error}</span>}
    </span>
  );
}

export function NavLinks({ state, onChange, route }) {
  const { error, run } = useAction(onChange);
  return (
    <nav className="nav-links">
      <button
        className={`nav-item ${route?.page === 'settings' ? 'active' : ''}`}
        onClick={() => navigate('/settings')}
      >
        <Gear size={16} /> {t('settings')}
      </button>
      <button
        className={`nav-item ${route?.page === 'usage' ? 'active' : ''}`}
        onClick={() => navigate('/usage')}
      >
        <Gauge size={16} /> {t('usage.title')}
      </button>
      {state.scope === 'remote' && (
        <button className="nav-item" onClick={() => run(() => api('/api/logout', {}))}>
          <Logout size={16} /> {t('logout')}
        </button>
      )}
      <ConfirmButton
        className="nav-item danger"
        onConfirm={() => run(() => api('/api/killall', {}))}
        armedLabel={t('killAllArmed')}
      >
        <Power size={16} /> {t('killAll')}
      </ConfirmButton>
      {error && <p className="error small">{error}</p>}
    </nav>
  );
}
