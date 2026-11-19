import { useEffect, useState } from 'react';

// Two taps instead of a modal: the first arms the button for a few seconds.
export default function ConfirmButton({ onConfirm, armedLabel, children, className = '', disabled }) {
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!armed) return undefined;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);

  return (
    <button
      className={`${className} ${armed ? 'armed' : ''}`}
      disabled={disabled}
      onClick={() => {
        if (armed) {
          setArmed(false);
          onConfirm();
        } else {
          setArmed(true);
        }
      }}
    >
      {armed ? armedLabel : children}
    </button>
  );
}
