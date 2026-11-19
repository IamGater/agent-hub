// xterm.js injects <style> elements at runtime and has no CSP nonce option. Instead of allowing
// 'unsafe-inline', every <style> created by this page gets the per-response nonce from the server.
// Must be imported before anything that creates styles.
const nonce = document.querySelector('meta[name="csp-nonce"]')?.getAttribute('content') ?? '';
const create = Document.prototype.createElement;

Document.prototype.createElement = function createElement(tag, options) {
  const el = create.call(this, tag, options);
  if (nonce && String(tag).toLowerCase() === 'style') el.setAttribute('nonce', nonce);
  return el;
};
