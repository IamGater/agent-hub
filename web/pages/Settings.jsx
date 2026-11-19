import { useCallback, useEffect, useState } from 'react';
import { api, dangerous, messageOf } from '../api.js';
import { LANGUAGES, setLang, t, useLang } from '../i18n.js';
import ConfirmButton from '../components/ConfirmButton.jsx';
import { Phone, Power } from '../components/Icons.jsx';
import { useControl } from '../hooks/useCountdown.js';

function date(ms) {
  return ms ? new Date(ms).toLocaleString() : t('settings.never');
}

function Language() {
  const lang = useLang();
  return (
    <section className="card stack-sm">
      <h3>{t('settings.language')}</h3>
      <div className="segmented" role="radiogroup" aria-label={t('settings.language')}>
        {LANGUAGES.map((l) => (
          <button
            key={l.id}
            role="radio"
            aria-checked={lang === l.id}
            className={lang === l.id ? 'on' : ''}
            onClick={() => setLang(l.id)}
          >
            {l.name}
          </button>
        ))}
      </div>
      <p className="muted small">{t('settings.languageHint')}</p>
    </section>
  );
}

function ConnectPhone({ state }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function issue() {
    setBusy(true);
    setError(null);
    try {
      setCode((await dangerous({ type: 'remote-enroll' })).code);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <h4>{t('settings.connect')}</h4>
      <ol className="steps">
        {!state.remote.enabled && <li>{t('settings.step1')}</li>}
        <li>{t('settings.step2', { origin: state.remote.origin })}</li>
        <li>{t('settings.step3')}</li>
      </ol>
      {code ? (
        <p className="pop-in">
          {t('settings.code')} <code className="code">{code}</code>
        </p>
      ) : (
        <button className="btn primary" disabled={busy} onClick={issue}>
          {t('settings.getCode')}
        </button>
      )}
      {error && <p className="error">{messageOf(error)}</p>}
    </div>
  );
}

function PhoneSettings({ state, onChange }) {
  const [list, setList] = useState([]);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const local = state.scope === 'local';

  const load = useCallback(() => api('/api/passkeys').then(setList, setError), []);

  useEffect(() => {
    let alive = true;
    api('/api/passkeys').then(
      (list) => alive && setList(list),
      (err) => alive && setError(err),
    );
    return () => {
      alive = false;
    };
  }, []);

  async function run(action) {
    setBusy(true);
    setError(null);
    try {
      const res = await dangerous(action);
      setName('');
      if (res.loggedOut) return onChange();
      await load();
      await onChange();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card stack">
      <h3 className="row">
        <Phone size={18} /> {t('settings.phone')}
      </h3>
      {local && state.remote.configured && <ConnectPhone state={state} />}
      {local && !state.remote.configured && <p className="muted small">{t('settings.noOrigin')}</p>}
      {list.length > 0 && <h4>{t('settings.passkeys')}</h4>}
      <ul className="plain">
        {list.map((p) => (
          <li key={p.id} className="subcard stack-sm">
            <div className="row">
              <strong>{p.name}</strong>
              {p.current && <span className="pill">{t('settings.thisSession')}</span>}
            </div>
            <div className="muted small">
              {t('settings.created', { created: date(p.createdAt), used: date(p.lastUsedAt) })}
            </div>
            <ConfirmButton
              className="btn danger"
              disabled={busy}
              armedLabel={t('settings.removeArmed')}
              onConfirm={() => run({ type: 'remove-passkey', passkeyId: p.id })}
            >
              {t('settings.remove')}
            </ConfirmButton>
          </li>
        ))}
      </ul>
      {!local && (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            run({ type: 'add-passkey', name: name.trim() });
          }}
        >
          <label>
            {t('settings.another')}
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={40}
              placeholder={t('settings.anotherPlaceholder')}
              required
            />
          </label>
          <p className="muted small">{t('settings.anotherHint')}</p>
          <button className="btn" disabled={busy || !name.trim()}>
            {t('settings.add')}
          </button>
        </form>
      )}
      {error && <p className="error">{messageOf(error)}</p>}
    </section>
  );
}

function Permissions({ agents, control }) {
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const chats = agents.filter((a) => a.type !== 'terminal');
  if (!chats.length) return null;

  async function set(agent, mode) {
    if ((mode === 'auto') === agent.autoApprove) return;
    setBusy(agent.id);
    setError(null);
    try {
      // Giving the permission asks for the passkey on the phone; taking it back does not.
      if (mode === 'auto') await dangerous({ type: 'auto-approve', agentId: agent.id });
      else await api(`/api/agents/${encodeURIComponent(agent.id)}/permissions/ask`, {});
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="card stack-sm">
      <h3>{t('perm.title')}</h3>
      <p className="muted small">{t('perm.hint')}</p>
      {chats.map((a) => (
        <div className="field-row perm-row" key={a.id}>
          <span>{a.name}</span>
          <div className="segmented" role="radiogroup" aria-label={a.name}>
            {['ask', 'auto'].map((mode) => (
              <button
                key={mode}
                role="radio"
                aria-checked={(mode === 'auto') === a.autoApprove}
                className={`${(mode === 'auto') === a.autoApprove ? 'on' : ''} ${mode === 'auto' ? 'risky' : ''}`}
                disabled={!control || busy === a.id}
                onClick={() => set(a, mode)}
              >
                {t(`perm.${mode}`)}
              </button>
            ))}
          </div>
        </div>
      ))}
      {chats.some((a) => a.autoApprove) && <p className="warn-text small">{t('perm.warning')}</p>}
      {!control && <p className="muted small">{t('viewModeHint')}</p>}
      {error && <p className="error small">{messageOf(error)}</p>}
    </section>
  );
}

const WAIT_OPTIONS = [5, 15, 30, 60, 120];

function Switch({ on, label, disabled, onChange }) {
  return (
    <button
      className={`toggle ${on ? 'on' : ''}`}
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
    >
      <span />
    </button>
  );
}

/** What closing the app window on this computer does to the agents and the server. */
function OnClose({ state }) {
  const [value, setValue] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const local = state.scope === 'local';

  useEffect(() => {
    let alive = true;
    api('/api/settings/on-close').then(
      (v) => alive && setValue(v),
      (err) => alive && setError(err),
    );
    return () => {
      alive = false;
    };
  }, []);

  async function save(patch) {
    const before = value;
    const next = { ...value, ...patch };
    setValue(next);
    setBusy(true);
    setError(null);
    try {
      setValue(await api('/api/settings/on-close', next));
    } catch (err) {
      setError(err);
      setValue(before);
    } finally {
      setBusy(false);
    }
  }

  if (!value) return error ? <p className="error small">{messageOf(error)}</p> : null;
  const stop = value.agents === 'stop';
  const off = !local || busy;

  return (
    <section className="card stack-sm">
      <h3>{t('close.title')}</h3>
      <p className="muted small">{t('close.hint')}</p>

      <div className="perm-row">
        <span>{t('close.agents')}</span>
        <div className="segmented" role="radiogroup" aria-label={t('close.agents')}>
          {['keep', 'stop'].map((mode) => (
            <button
              key={mode}
              role="radio"
              aria-checked={value.agents === mode}
              className={value.agents === mode ? 'on' : ''}
              disabled={off}
              onClick={() => value.agents !== mode && save({ agents: mode })}
            >
              {t(`close.${mode}`)}
            </button>
          ))}
        </div>
      </div>
      <p className="muted small">{stop ? t('close.stopHint') : t('close.keepHint')}</p>

      {stop && (
        <>
          <div className="field-row">
            <span>{t('close.wait')}</span>
            <select
              value={value.waitMinutes}
              disabled={off}
              aria-label={t('close.wait')}
              onChange={(e) => save({ waitMinutes: Number(e.target.value) })}
            >
              {[...new Set([...WAIT_OPTIONS, value.waitMinutes])]
                .sort((a, b) => a - b)
                .map((m) => (
                  <option key={m} value={m}>
                    {t('close.minutes', { n: String(m) })}
                  </option>
                ))}
            </select>
          </div>
          <div className="field-row">
            <span>{t('close.remote')}</span>
            <Switch
              on={value.keepForRemote}
              label={t('close.remote')}
              disabled={off}
              onChange={(v) => save({ keepForRemote: v })}
            />
          </div>
          <p className="muted small">{t('close.remoteHint')}</p>
          <div className="field-row">
            <span>{t('close.exit')}</span>
            <Switch
              on={value.exit}
              label={t('close.exit')}
              disabled={off}
              onChange={(v) => save({ exit: v })}
            />
          </div>
          <p className="muted small">{t('close.exitHint')}</p>
        </>
      )}

      {!local && <p className="muted small">{t('close.localOnly')}</p>}
      {error && <p className="error small">{messageOf(error)}</p>}
    </section>
  );
}

/** Turns the computer off after Windows' one-minute notice, which can be cancelled from here. */
function PowerOff() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [until, setUntil] = useState(null);

  async function run(fn) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const shutdown = () =>
    run(async () => {
      const res = await dangerous({ type: 'shutdown' });
      setUntil(Date.now() + res.delaySeconds * 1000);
    });
  const cancel = () =>
    run(async () => {
      await api('/api/power/cancel', {});
      setUntil(null);
    });

  return (
    <section className="card stack-sm">
      <h3>{t('power.title')}</h3>
      <p className="muted small">{t('power.hint')}</p>
      {until ? (
        <>
          <p className="warn-text">{t('power.scheduled', { time: new Date(until).toLocaleTimeString() })}</p>
          <button className="btn primary" disabled={busy} onClick={cancel}>
            {t('power.cancel')}
          </button>
        </>
      ) : (
        <ConfirmButton
          className="btn danger"
          disabled={busy}
          armedLabel={t('power.armed')}
          onConfirm={shutdown}
        >
          <Power size={15} /> {t('power.button')}
        </ConfirmButton>
      )}
      {error && <p className="error small">{messageOf(error)}</p>}
    </section>
  );
}

export default function Settings({ state, onChange, agents, conn }) {
  const { control } = useControl(conn.mode);
  return (
    <main className="page stack">
      <h1 className="hero small-hero">{t('settings')}</h1>
      <Language />
      <Permissions agents={agents} control={control} />
      <OnClose state={state} />
      <PhoneSettings state={state} onChange={onChange} />
      <PowerOff />
    </main>
  );
}
