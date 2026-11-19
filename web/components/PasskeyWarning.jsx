import { t } from '../i18n.js';
import { navigate } from '../hooks/useRoute.js';

export default function PasskeyWarning() {
  return (
    <div className="banner" role="status">
      {t('phoneNotConnected')}{' '}
      <button className="link" onClick={() => navigate('/settings')}>
        {t('connect')}
      </button>
    </div>
  );
}
