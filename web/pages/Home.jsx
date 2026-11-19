import { t } from '../i18n.js';
import { navigate } from '../hooks/useRoute.js';
import { folderName } from '../components/Sidebar.jsx';
import StatusDot, { statusText } from '../components/StatusDot.jsx';

function greeting() {
  const h = new Date().getHours();
  if (h < 5) return t('greeting.night');
  if (h < 12) return t('greeting.morning');
  if (h < 18) return t('greeting.day');
  return t('greeting.evening');
}

export default function Home({ agents }) {
  const waiting = agents.filter((a) => a.status === 'waiting').length;
  const running = agents.filter((a) => a.status === 'running' || a.status === 'waiting').length;

  return (
    <main className="home">
      <h1 className="hero">{greeting()}</h1>
      <p className="muted hero-sub">
        {waiting
          ? t('home.waiting', { n: waiting })
          : running
            ? t('home.running', { n: running })
            : t('home.idle')}
      </p>
      {agents.length ? (
        <ul className="cards">
          {agents.map((a) => (
            <li key={a.id}>
              <button
                className={`card-btn ${a.status}`}
                onClick={() => navigate(`/agent/${encodeURIComponent(a.id)}`)}
              >
                <span className="card-top">
                  <span className="card-name">{a.name}</span>
                  <span className={`pill status ${a.status}`}>
                    <StatusDot status={a.status} />
                    {statusText(a)}
                  </span>
                </span>
                <span className="muted small mono card-folder">{folderName(a.cwd)}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">{t('noAgents')}</p>
      )}
    </main>
  );
}
