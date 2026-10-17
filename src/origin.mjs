// Origin pinning: a credential may only be typed into pages whose origin was approved when it was added.
const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]']);

export function parseOrigin(input) {
  let u;
  try { u = new URL(input); } catch { return null; }
  const local = LOCAL.has(u.hostname) || u.hostname.endsWith('.localhost');
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return null;
  return u.origin;
}

// Allowed entries: exact origin ("https://a.com") or wildcard host ("https://*.a.com", subdomains only).
export function normalizeAllowed(entry) {
  const m = /^(https?):\/\/\*\.([^/:]+)(:\d+)?\/?$/.exec(entry);
  if (m) {
    if (m[1] === 'http') return null;
    if (!m[2].includes('.')) return null; // refuse https://*.com
    return `https://*.${m[2].toLowerCase()}${m[3] ?? ''}`;
  }
  return parseOrigin(entry);
}

export function isAllowed(url, allowed) {
  const origin = parseOrigin(url);
  if (!origin) return false;
  const host = new URL(origin).host;
  return allowed.some((a) => {
    if (a === origin) return true;
    const m = /^https:\/\/\*\.(.+)$/.exec(a);
    return !!m && origin.startsWith('https://') && host.endsWith('.' + m[1]);
  });
}

// Never echo query strings or fragments: they routinely carry tokens.
export function safeUrl(url) {
  try { const u = new URL(url); return u.origin + u.pathname; } catch { return ''; }
}

// "Same site" ~ same registrable domain (www.example.com == example.com == app.example.com), using a small built-in
// suffix heuristic instead of the full public-suffix list. Errs toward "same" so benign redirects do not nag the user.
const SLD = new Set(['co', 'com', 'org', 'net', 'gov', 'edu', 'ac']);
export function siteOf(host) {
  const h = host.replace(/^www\./, '').toLowerCase();
  if (/^[\d.]+$/.test(h) || h.includes(':')) return h;
  const l = h.split('.');
  if (l.length <= 2) return h;
  const n = l[l.length - 1].length === 2 && SLD.has(l[l.length - 2]) ? 3 : 2;
  return l.slice(-n).join('.');
}
export function sameSite(a, b) {
  try { return siteOf(new URL(a).hostname) === siteOf(new URL(b).hostname); } catch { return false; }
}

export function globToRegExp(glob) {
  const esc = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '.*');
  return new RegExp('^' + esc + '$');
}
