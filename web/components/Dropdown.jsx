import { useEffect, useId, useRef, useState } from 'react';
import { useFitInView } from '../hooks/useFitInView.js';
import { Check, Chevron } from './Icons.jsx';

/**
 * A styled select: the native one keeps the system look (a white Windows list in a dark app).
 * options: [{ value, label, sub? }]. `trigger` replaces the button content, for menu-like uses.
 */
export default function Dropdown({
  value,
  options,
  onChange,
  label,
  disabled,
  icon,
  trigger,
  className = '',
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const root = useRef(null);
  const list = useRef(null);
  const listId = useId();
  const current = options.find((o) => o.value === value);
  useFitInView(list, open);

  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => {
      if (!root.current?.contains(e.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);

  function show() {
    setActive(
      Math.max(
        0,
        options.findIndex((o) => o.value === value),
      ),
    );
    setOpen(true);
  }

  function pick(o) {
    setOpen(false);
    onChange(o.value);
  }

  function onKey(e) {
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
        e.preventDefault();
        show();
      }
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(options.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (options[active]) pick(options[active]);
    } else if (e.key === 'Tab') {
      setOpen(false);
    }
  }

  return (
    <div className={`dropdown ${open ? 'open' : ''} ${className}`} ref={root}>
      <button
        type="button"
        className={trigger ? 'dropdown-trigger' : 'dropdown-btn'}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-label={label}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={onKey}
      >
        {trigger ?? (
          <>
            {icon}
            <span className="dropdown-value">{current?.label ?? value}</span>
            <Chevron size={15} />
          </>
        )}
      </button>
      {open && (
        <ul className="dropdown-list" role="listbox" id={listId} aria-label={label} ref={list}>
          {options.map((o, i) => (
            <li
              key={o.value}
              role="option"
              aria-selected={o.value === value}
              className={`dropdown-option ${i === active ? 'active' : ''}`}
              onPointerEnter={() => setActive(i)}
              onClick={() => pick(o)}
            >
              <span className="dropdown-option-text">
                <span>{o.label}</span>
                {o.sub && <span className="dropdown-sub">{o.sub}</span>}
              </span>
              {o.value === value && <Check size={15} />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
