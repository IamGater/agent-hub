import { useState } from 'react';
import { enroll, login, messageOf } from '../api.js';
import { t } from '../i18n.js';
import { BrandMark, Key } from '../components/Icons.jsx';

export default function Login({ onDone }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [joining, setJoining] = useState(false);
  const [code, setCode] = useState('');
  const [name, setName] = useState(() => t('login.defaultName'));

  async function run(fn) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth">
      <div className="auth-card">
        <span className="auth-mark">
          <BrandMark />
        </span>
        {joining ? (
          <>
            <h1 className="hero small-hero">{t('login.joinTitle')}</h1>
            <p className="muted">{t('login.joinHint')}</p>
            <form
              className="stack"
              onSubmit={(e) => {
                e.preventDefault();
                run(() => enroll(code.trim(), name.trim()));
              }}
            >
              <label>
                {t('login.code')}
                <input
                  className="mono"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  autoComplete="off"
                  autoCapitalize="characters"
                  spellCheck={false}
                  maxLength={64}
                  required
                />
              </label>
              <label>
                {t('login.name')}
                <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} />
              </label>
              <button className="btn primary big" disabled={busy || !code.trim()}>
                {t('login.create')}
              </button>
            </form>
            <button className="link" onClick={() => setJoining(false)}>
              {t('login.back')}
            </button>
          </>
        ) : (
          <>
            <h1 className="hero small-hero">Agent Hub</h1>
            <p className="muted">{t('login.tagline')}</p>
            <button className="btn primary big" disabled={busy} onClick={() => run(login)}>
              <Key size={18} /> {t('login.signIn')}
            </button>
            <button className="link" onClick={() => setJoining(true)}>
              {t('login.joinLink')}
            </button>
          </>
        )}
        {error && <p className="error">{messageOf(error)}</p>}
      </div>
    </main>
  );
}
