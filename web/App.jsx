import { useCallback, useEffect, useState } from 'react';
import { ApiError, api, messageOf, setScope } from './api.js';
import { t, useLang } from './i18n.js';
import { useConnection } from './hooks/useConnection.js';
import { useMedia } from './hooks/useMedia.js';
import { useRoute } from './hooks/useRoute.js';
import PasskeyWarning from './components/PasskeyWarning.jsx';
import Sidebar from './components/Sidebar.jsx';
import TopBar from './components/TopBar.jsx';
import Login from './pages/Login.jsx';
import Home from './pages/Home.jsx';
import Agent from './pages/Agent.jsx';
import Settings from './pages/Settings.jsx';
import Usage from './pages/Usage.jsx';

export default function App() {
  const [state, setState] = useState(null);
  const [error, setError] = useState(null);
  const route = useRoute();
  const wide = useMedia('(min-width: 900px)');
  // Subscribing here re-renders the whole tree when the language changes.
  useLang();

  const refresh = useCallback(
    () =>
      api('/api/state').then(
        (s) => {
          setState(s);
          setError(null);
        },
        (err) => {
          setState(null);
          setError(err);
        },
      ),
    [],
  );

  useEffect(() => {
    let alive = true;
    let timer;
    // A network error right at load (a phone waking up, a flaky connection) is retried a few
    // times; an answer from the server, even an error, is shown as it is.
    const load = (tries) =>
      api('/api/state').then(
        (s) => alive && setState(s),
        (err) => {
          if (!alive) return;
          if (!(err instanceof ApiError) && tries > 0) timer = setTimeout(() => load(tries - 1), 1000);
          else setError(err);
        },
      );
    load(3);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    if (state) setScope(state.scope);
  }, [state]);

  const conn = useConnection(Boolean(state?.authenticated), refresh);

  if (!state) {
    return (
      <main className="auth">
        <div className="auth-card">
          {error ? <p className="error">{messageOf(error)}</p> : <p className="muted">{t('loading')}</p>}
          {error && (
            <button className="btn" onClick={refresh}>
              {t('retry')}
            </button>
          )}
        </div>
      </main>
    );
  }

  if (!state.authenticated) return <Login onDone={refresh} />;

  let page;
  let title = '';
  if (route.page === 'agent') {
    const agent = conn.agents.find((a) => a.id === route.arg);
    title = agent?.name ?? '';
    page = agent ? (
      <Agent key={agent.id} agent={agent} agents={conn.agents} conn={conn} wide={wide} />
    ) : (
      <p className="muted page">{t('agentNotFound')}</p>
    );
  } else if (route.page === 'usage') {
    title = t('usage.title');
    page = <Usage agents={conn.agents} conn={conn} />;
  } else if (route.page === 'settings' || route.page === 'passkeys') {
    title = t('settings');
    page = <Settings state={state} onChange={refresh} agents={conn.agents} conn={conn} />;
  } else {
    page = <Home agents={conn.agents} />;
  }

  return (
    <div className={`app ${wide ? 'wide' : 'narrow'}`}>
      {wide ? (
        <Sidebar agents={conn.agents} route={route} state={state} onChange={refresh} online={conn.online} />
      ) : (
        <TopBar conn={conn} state={state} onChange={refresh} route={route} title={title} />
      )}
      <div className="main">
        {state.scope === 'local' && state.remote.configured && state.passkeys === 0 && <PasskeyWarning />}
        <div className="page-enter" key={`${route.page}/${route.arg}`}>
          {page}
        </div>
      </div>
    </div>
  );
}
