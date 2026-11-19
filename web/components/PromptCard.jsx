import { t } from '../i18n.js';

// Shows the whole tail of the agent screen, not a parsed summary: the owner must see the exact
// command being approved. Deliberately no "always allow" option.
export default function PromptCard({ agent, control, onKey }) {
  return (
    <section className="prompt" aria-live="assertive">
      <h3>{t('promptTitle')}</h3>
      {/* column-reverse keeps the scroll anchored at the bottom, where the question is */}
      <div className="prompt-scroll">
        <pre className="prompt-text">{agent.prompt}</pre>
      </div>
      <dl>
        <dt>{t('folder')}</dt>
        <dd className="mono">{agent.cwd}</dd>
        <dt>{t('command')}</dt>
        <dd className="mono">{[agent.command, ...agent.args].join(' ')}</dd>
      </dl>
      {control ? (
        <div className="prompt-actions">
          <button className="btn primary" onClick={() => onKey('y')}>
            y
          </button>
          <button className="btn" onClick={() => onKey('n')}>
            n
          </button>
          <button className="btn" onClick={() => onKey('\r')}>
            Enter
          </button>
          <button className="btn" onClick={() => onKey('\x1b')}>
            Esc
          </button>
        </div>
      ) : (
        <p className="muted small">{t('unlockToAnswer')}</p>
      )}
    </section>
  );
}
