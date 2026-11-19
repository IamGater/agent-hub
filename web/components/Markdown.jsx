// A small subset of Markdown rendered as React elements. Agent text is never turned into HTML:
// a model that read a hostile file must not be able to inject markup or links into the page.

const FENCE = /```[^\n`]*\n?([\s\S]*?)```/g;
const INLINE = /(`[^`\n]+`|\*\*[^*\n]+\*\*)/g;

function inline(text, key) {
  return text.split(INLINE).map((part, i) => {
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      return <code key={`${key}-${i}`}>{part.slice(1, -1)}</code>;
    }
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return <strong key={`${key}-${i}`}>{part.slice(2, -2)}</strong>;
    }
    return part;
  });
}

const ROW = /^\s*\|.*\|\s*$/;
const RULE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

/** "| a | b |" -> ["a", "b"] */
function cells(line) {
  return line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((c) => c.trim());
}

/** A block whose second line is a "|---|---|" rule is a table; it scrolls sideways on a phone. */
function table(p, key) {
  const lines = p.split('\n').filter((l) => l.trim());
  if (lines.length < 2 || !ROW.test(lines[0]) || !RULE.test(lines[1])) return null;
  if (!lines.slice(2).every((l) => ROW.test(l))) return null;
  const [head, , ...body] = lines;
  return (
    <div key={key} className="md-table">
      <table>
        <thead>
          <tr>
            {cells(head).map((c, i) => (
              <th key={i}>{inline(c, `${key}-h${i}`)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, r) => (
            <tr key={r}>
              {cells(row).map((c, i) => (
                <td key={i}>{inline(c, `${key}-${r}-${i}`)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function paragraphs(text, key) {
  return text
    .split(/\n{2,}/)
    .filter((p) => p.trim())
    .map((p, i) => {
      const grid = table(p, `${key}-${i}`);
      if (grid) return grid;
      const heading = /^#{1,6}\s+(.*)$/.exec(p);
      if (heading && !p.includes('\n')) {
        return (
          <p key={`${key}-${i}`} className="md-h">
            {inline(heading[1], `${key}-${i}`)}
          </p>
        );
      }
      return <p key={`${key}-${i}`}>{inline(p.replace(/^\n+|\n+$/g, ''), `${key}-${i}`)}</p>;
    });
}

export default function Markdown({ text }) {
  const out = [];
  let last = 0;
  let n = 0;
  for (const m of text.matchAll(FENCE)) {
    out.push(...paragraphs(text.slice(last, m.index), `t${n}`));
    out.push(
      <pre key={`c${n}`} className="md-code">
        <code>{m[1].replace(/\n$/, '')}</code>
      </pre>,
    );
    last = m.index + m[0].length;
    n++;
  }
  out.push(...paragraphs(text.slice(last), `t${n}`));
  return <div className="md">{out}</div>;
}
