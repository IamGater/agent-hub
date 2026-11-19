import { useState } from 'react';
import { t } from '../i18n.js';
import { navigate } from '../hooks/useRoute.js';
import { ModeControl, NavLinks, RemoteSwitch } from './Controls.jsx';
import { Back, BrandMark, Menu } from './Icons.jsx';

// Phone layout: brand or back arrow, the mode control, and a menu with everything else.
export default function TopBar({ conn, state, onChange, route, title }) {
  // The menu belongs to the page it was opened on: going anywhere else (a link, the back
  // gesture) closes it instead of leaving it over the next page.
  const here = `${route.page}/${route.arg ?? ''}`;
  const [openOn, setOpenOn] = useState(null);
  const open = openOn === here;
  const setOpen = (v) => setOpenOn(v ? here : null);
  const home = route.page === '';

  return (
    <header className="topbar">
      <div className="topbar-row">
        {home ? (
          <span className="brand">
            <BrandMark />
            Agent Hub
          </span>
        ) : (
          <>
            <button className="icon-btn" aria-label={t('back')} onClick={() => navigate('/')}>
              <Back />
            </button>
            <span className="topbar-title">{title}</span>
          </>
        )}
        <span className="spacer" />
        {!conn.online && <span className="pill warn">{t('offlineShort')}</span>}
        <ModeControl conn={conn} />
        <button
          className="icon-btn"
          aria-label={t('menu')}
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <Menu />
        </button>
      </div>
      {open && <div className="backdrop" onClick={() => setOpen(false)} />}
      {open && (
        <div className="menu" onClick={(e) => e.target.closest('.nav-item') && setOpen(false)}>
          <RemoteSwitch state={state} onChange={onChange} />
          <NavLinks state={state} onChange={onChange} route={route} />
        </div>
      )}
    </header>
  );
}
