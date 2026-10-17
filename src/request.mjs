// Just-in-time credential entry. The agent asks for a login to be added; a PERSON types it into a one-time local form.
// The password goes browser -> this process -> sealed vault. It is never returned to, or readable by, the agent.
//
// Hardening: loopback only; unguessable one-time path; Host + Origin checks (DNS-rebinding / cross-site posts);
// CSRF token; strict CSP, no external resources, no caching, no referrer; size-capped body; expires; single use.
// The page states, in large type, exactly which origin the password will be pinned to, because the agent chooses the URL.
import crypto from 'node:crypto';
import http from 'node:http';
import * as vault from './vault.mjs';
import { parseOrigin } from './origin.mjs';
import { parseTotpInput, base32Decode } from './totp.mjs';
import { openInDefaultBrowser } from './ui.mjs';
import { audit } from './audit.mjs';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const mask = (u) => (u.includes('@') ? u[0] + '***@' + u.split('@')[1] : u.slice(0, 1) + '***');
const defaultName = (origin) => new URL(origin).hostname.replace(/^www\./, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'site';

const HEADERS = {
  'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
};

function page({ origin, name, actor, csrf, error }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Hallpass: add a login</title><style>
:root{color-scheme:light dark;--bg:#fafaf8;--fg:#1b1b18;--mut:#60605a;--card:#fff;--line:#d9d9d2;--acc:#1f5eff;--bad:#b3261e}
@media(prefers-color-scheme:dark){:root{--bg:#161615;--fg:#f2f2ee;--mut:#a3a39a;--card:#1f1f1d;--line:#34342f;--acc:#7da2ff;--bad:#ff8a80}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,Segoe UI,sans-serif}
main{max-width:30rem;margin:0 auto;padding:2rem 1rem}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:1.25rem 1.25rem 1.5rem}
h1{font-size:1.25rem;margin:0 0 .25rem}p{margin:.5rem 0;color:var(--mut)}
.origin{font:600 1.15rem/1.3 ui-monospace,Consolas,monospace;word-break:break-all;color:var(--fg);background:color-mix(in srgb,var(--acc) 12%,transparent);padding:.6rem .75rem;border-radius:8px;margin:.5rem 0}
label{display:block;margin:1rem 0 .25rem;font-weight:600}input[type=text],input[type=password]{width:100%;box-sizing:border-box;padding:.6rem .7rem;font-size:1rem;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg)}
.row{display:flex;gap:.6rem;align-items:flex-start;margin:1rem 0}.row input{margin-top:.35rem}
button{margin-top:.5rem;width:100%;padding:.7rem;font-size:1rem;font-weight:600;border:0;border-radius:8px;background:var(--acc);color:#fff;cursor:pointer}
.err{color:var(--bad);font-weight:600}small{color:var(--mut)}
</style></head><body><main><div class="card">
<h1>Add a login for ${esc(name)}</h1>
<p>${esc(actor)} asked to use a login for this site. <b>It cannot see what you type here.</b> Hallpass stores it encrypted on this computer and will only ever type it into:</p>
<div class="origin">${esc(origin)}</div>
<p>If that is not the real site you intend to sign in to, close this tab.</p>
${error ? `<p class="err">${esc(error)}</p>` : ''}
<form method="POST" autocomplete="off">
<input type="hidden" name="csrf" value="${esc(csrf)}">
<label for="u">Username or email</label><input id="u" name="username" type="text" required autocomplete="off" autofocus>
<label for="p">Password</label><input id="p" name="password" type="password" required minlength="6" autocomplete="new-password">
<label for="t">Authenticator secret or otpauth:// link <small>(optional: lets Hallpass fill 2FA codes)</small></label><input id="t" name="totp" type="password" autocomplete="off">
<div class="row"><input id="c" name="confirm" type="checkbox" value="1" required><label for="c" style="margin:0;font-weight:400">I trust <b>${esc(origin)}</b> and want this login used only there.</label></div>
<div class="row"><input id="a" name="approval" type="checkbox" value="1"><label for="a" style="margin:0;font-weight:400">Ask me to approve each sign-in (recommended).</label></div>
<button type="submit">Save login</button></form></div>
<p><small>This page is served from your own computer (127.0.0.1) and works once, for a few minutes.</small></p></main></body></html>`;
}

const donePage = (name) => `<!doctype html><meta charset="utf-8"><title>Saved</title><body style="font:16px system-ui;max-width:28rem;margin:3rem auto;padding:0 1rem"><h1>Saved: ${esc(name)}</h1><p>You can close this tab and go back to your AI tool. It can now sign in without ever seeing the password.</p>`;

const pendingByOrigin = new Set();
let recentStarts = [];

/** What the agent is told. The one-time form URL is included ONLY when no window could be opened for the person:
 *  otherwise an agent that knew it could pre-submit its own credential and consume the form before the person does. */
export function describeRequest(req) {
  const out = { status: 'awaiting_user', name: req.name, origin: req.origin, form_opened: req.opened, expires_in_sec: req.expiresInSec };
  if (!req.opened) out.form_url = req.formUrl;
  out.message = req.opened
    ? `A form is open in the user's browser. Tell them to enter the login for ${req.origin} there (you cannot see it), wait for their reply, then call hallpass open again.`
    : `The form could not be opened automatically. Give the user this one-time link to open in their own browser: ${req.formUrl}  (they enter the login for ${req.origin}; you cannot see it). Wait for their reply, then call hallpass open again.`;
  return out;
}

export async function startCredentialRequest({ url, name, ttlSec = 600, actor = process.env.HALLPASS_ACTOR === 'mcp' ? 'Your AI tool' : 'A command-line agent', launch = true } = {}) {
  const origin = parseOrigin(url || '');
  if (!origin) throw new Error('url must be https:// (http:// only for localhost)');
  name = name || defaultName(origin);
  if (!vault.validName(name)) throw new Error('invalid name: use lowercase letters, digits, . _ -');
  if (name.startsWith('site-')) throw new Error('names starting with "site-" are reserved');
  if (vault.exists(name)) throw new Error(`"${name}" already exists. Only a person can replace it: hallpass add ${name} --force`);

  if (pendingByOrigin.has(origin)) throw new Error(`a credential form for ${origin} is already waiting for the user: ask them to finish (or let it expire) first`);
  const nowMs = Date.now();
  recentStarts = recentStarts.filter((t) => nowMs - t < 10 * 60 * 1000);
  if (recentStarts.length >= 12) throw new Error('too many credential forms requested in the last 10 minutes');
  recentStarts.push(nowMs);
  pendingByOrigin.add(origin);

  const token = crypto.randomBytes(32).toString('hex');
  const csrf = crypto.randomBytes(16).toString('hex');
  let attempts = 0, finished = false, resolveDone;
  const done = new Promise((r) => (resolveDone = r));

  const server = http.createServer((req, res) => {
    const send = (code, body, type = 'text/html; charset=utf-8') => { res.writeHead(code, { 'Content-Type': type, ...HEADERS }); res.end(body); };
    const port = server.address().port;
    const hostOk = req.headers.host === `127.0.0.1:${port}`; // blocks DNS rebinding
    const u = new URL(req.url, 'http://x');
    if (!hostOk) return send(403, 'forbidden', 'text/plain');
    if (u.pathname !== `/r/${token}`) return send(404, 'not found', 'text/plain');

    if (req.method === 'GET') return send(200, page({ origin, name, actor, csrf }));
    if (req.method !== 'POST') return send(405, 'method not allowed', 'text/plain');
    if (req.headers.origin && req.headers.origin !== `http://127.0.0.1:${port}`) return send(403, 'forbidden', 'text/plain'); // cross-site form post
    if (!/^application\/x-www-form-urlencoded/i.test(req.headers['content-type'] || '')) return send(415, 'unsupported', 'text/plain');

    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 8192) { send(413, 'too large', 'text/plain'); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (res.writableEnded) return;
      const f = Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8')));
      const again = (msg) => send(400, page({ origin, name, actor, csrf, error: msg }));
      if (++attempts > 5) { finish({ status: 'cancelled', name, reason: 'too many attempts' }); return send(429, 'too many attempts', 'text/plain'); }
      if (!f.csrf || f.csrf.length !== csrf.length || !crypto.timingSafeEqual(Buffer.from(f.csrf), Buffer.from(csrf))) return send(403, 'forbidden', 'text/plain');
      if (f.confirm !== '1') return again('Please confirm you trust this site.');
      if (!f.username?.trim()) return again('Username is required.');
      if (!f.password || f.password.length < 6) return again('Password must be at least 6 characters.');
      let totpCfg;
      if (f.totp?.trim()) { try { totpCfg = parseTotpInput(f.totp); base32Decode(totpCfg.secret); } catch (e) { return again('That authenticator secret is not valid: ' + e.message); } }
      try {
        vault.put(name, {
          url, allowed: [origin], userHint: mask(f.username.trim()), hasTotp: !!totpCfg, selectors: {}, successUrl: null, successText: null,
          lockNavigation: false, createdAt: new Date().toISOString(), requireApproval: f.approval === '1', expiresAt: null, maxUses: null,
        }, { username: f.username.trim(), password: f.password, ...(totpCfg ? { totp: totpCfg } : {}) });
      } catch (e) { return send(500, 'could not save: ' + esc(e.message), 'text/plain'); }
      send(200, donePage(name));
      finish({ status: 'saved', name, origin, totp: !!totpCfg, requires_approval: f.approval === '1' });
    });
  });

  function finish(result) {
    if (finished) return;
    finished = true;
    pendingByOrigin.delete(origin);
    clearTimeout(timer);
    audit('request_credential', { name, origin, result: result.status });
    resolveDone(result);
    setTimeout(() => server.close(), 200).unref(); // let the final response flush
    server.closeAllConnections?.();
  }
  const timer = setTimeout(() => finish({ status: 'expired', name }), ttlSec * 1000);
  timer.unref();

  return new Promise((resolve, reject) => {
    server.on('error', (e) => { pendingByOrigin.delete(origin); reject(e); });
    server.listen(0, '127.0.0.1', () => {
      const formUrl = `http://127.0.0.1:${server.address().port}/r/${token}`;
      const opened = launch ? openInDefaultBrowser(formUrl) : false;
      audit('request_credential', { name, origin, result: 'started' });
      resolve({ formUrl, name, origin, opened, expiresInSec: ttlSec, wait: () => done, cancel: () => finish({ status: 'cancelled', name }) });
    });
  });
}
