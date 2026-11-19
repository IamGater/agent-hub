const KEYS = [
  ['Enter', '\r'],
  ['Esc', '\x1b'],
  ['Ctrl+C', '\x03'],
  ['Tab', '\t'],
  ['↑', '\x1b[A'],
  ['↓', '\x1b[B'],
  ['←', '\x1b[D'],
  ['→', '\x1b[C'],
  ['y', 'y'],
  ['n', 'n'],
  ['Ctrl+D', '\x04'],
];

// A phone keyboard has no Esc, Ctrl or arrows.
export default function KeyBar({ onKey, disabled }) {
  return (
    <div className="keybar">
      {KEYS.map(([label, seq]) => (
        <button type="button" key={label} className="chip" disabled={disabled} onClick={() => onKey(seq)}>
          {label}
        </button>
      ))}
    </div>
  );
}
