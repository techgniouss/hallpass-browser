// A tiny multi-scenario login site for end-to-end tests.
// "localhost:PORT" is the approved origin; "127.0.0.1:PORT" plays the attacker (different origin, same server).
import http from 'node:http';
import { totp } from '../src/totp.mjs';

export function startSite({ user, password, totpCfg, humanPassword = null, alsoAccept = [] }) {
  const log = { attempts: {}, posts: [], trap: [] };
  const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;
  const form = (action, fields, button, err = '') => page('Sign in', `
    <h1>Sign in</h1>${err ? `<div role="alert">${err}</div>` : ''}
    <form method="POST" action="${action}">${fields}<button type="submit">${button}</button>
    <button type="button" onclick="alert(1)">Continue with Google</button></form>`);
  const EMAIL = '<input type="email" name="email" placeholder="Email">';
  const PASS = '<input type="password" name="password" placeholder="Password"><input type="password" name="trap" style="display:none">';
  const cookies = (req) => Object.fromEntries((req.headers.cookie || '').split(/;\s*/).filter(Boolean).map((c) => c.split('=')));
  const body = (req) => new Promise((res) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => res(Object.fromEntries(new URLSearchParams(d)))); });
  const send = (res, html, code = 200, headers = {}) => { res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', ...headers }); res.end(html); };
  const redirect = (res, to, headers = {}) => { res.writeHead(302, { location: to, ...headers }); res.end(); };
  const attempt = (s) => (log.attempts[s] = (log.attempts[s] || 0) + 1);

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const p = u.pathname;
    const c = cookies(req);
    const port = server.address().port;
    const POST = req.method === 'POST' ? await body(req) : null;
    if (POST) { log.posts.push({ host: req.headers.host, path: p, body: POST }); if (POST.trap) log.trap.push(POST.trap); }

    const app = (scenario) => `/${scenario}/app`;
    const authed = (scenario) => c[`sess_${scenario}`] === 'ok';
    const ok = (scenario) => redirect(res, app(scenario), { 'set-cookie': `sess_${scenario}=ok; Path=/; Max-Age=3600` });

    const m = /^\/(simple|twostep|totp|captcha|badpw|phish|public|invite|bounce|danger|spa|play)\/(login|password|code|check|app|evil|api)$/.exec(p);
    if (!m) return send(res, page('404', 'nope'), 404);
    const [, s, step] = m;

    if (s === 'invite') return send(res, page('Team', '<h1>Team settings</h1><input type="email" name="invitee" placeholder="Teammate email"><button type="button">Send invite</button>'));
    if (s === 'bounce') return redirect(res, `http://localhost:${port}/public/app`);
    if (s === 'danger' && step === 'password') return send(res, page('Settings', '<h1>Settings</h1><input id="note" type="search" placeholder="note"><input id="pw" type="password" value="demo-typed-secret" aria-label="Password">'));
    if (s === 'danger') return send(res, page('Console', "<h1>Console</h1><input id=\"note\" type=\"search\" placeholder=\"note\"><button id=\"del\" onclick=\"document.title=&quot;DELETED&quot;\">Delete account</button> <button id=\"next\" onclick=\"document.title=&quot;NEXT&quot;\">Next</button> <button id=\"icon\" aria-label=\"Publish release\" onclick=\"document.title=&quot;PUBLISHED&quot;\">&#9733;</button> <button id=\"trash\" class=\"icon-btn btn-delete-user\" onclick=\"document.title=&quot;TRASHED&quot;\">&#128465;</button> <input id=\"sub\" type=\"submit\" value=\"Submit application\" onclick=\"document.title=&quot;SUBMITTED&quot;\">"));
    // A Play-Console-shaped release page: a hidden file input behind a visible button, a notes box, a harmless and a real "go" button.
    if (s === 'play') return send(res, page('Releases', '<h1>Internal testing</h1><button id="create" onclick="document.title=&quot;CREATED&quot;">Create new release</button> <button id="up" onclick="document.getElementById(&quot;f&quot;).click()">Upload</button><input id="f" type="file" multiple style="display:none" onchange="document.getElementById(&quot;o&quot;).textContent=[...this.files].map(f=>f.name+&quot;:&quot;+f.size).join(&quot;,&quot;)"><textarea id="notes" aria-label="Release notes"></textarea><pre id="o"></pre><button id="go" onclick="document.title=&quot;ROLLED&quot;">Start rollout to Internal testing</button>'));
    if (s === 'public') return send(res, page('Docs', '<h1>Public docs</h1>'));
    if (step === 'app') return authed(s) ? send(res, page('Dashboard', '<h1>Welcome back</h1><input type="search" placeholder="Search">')) : redirect(res, `/${s}/login`);

    if (s === 'spa') { // single-page app: fetch() login, no reload, so a rejected password stays in the field
      if (step === 'login') return authed(s) ? redirect(res, app(s)) : send(res, page('Sign in', '<h1>Sign in</h1><div id="msg"></div><form id="f"><input type="email" name="email" placeholder="Email"><input type="password" name="password" placeholder="Password"><button type="submit">Sign in</button></form><script>document.getElementById("f").addEventListener("submit", async (e) => { e.preventDefault(); const r = await fetch("/spa/api", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(new FormData(e.target)) }); if (r.ok) location.href = "/spa/app"; else { const m = document.getElementById("msg"); m.setAttribute("role", "alert"); m.textContent = "Incorrect email or password"; } });</script>'));
      if (step === 'api' && POST) { attempt(s); const good = POST.email === user && (POST.password === password || alsoAccept.includes(POST.password)); res.writeHead(good ? 200 : 401, { 'content-type': 'application/json', ...(good ? { 'set-cookie': 'sess_spa=ok; Path=/; Max-Age=3600' } : {}) }); return res.end(JSON.stringify({ ok: good })); }
    }
    if (s === 'simple' || s === 'badpw') {
      if (POST) {
        attempt(s);
        return POST.email === user && (POST.password === password || POST.password === humanPassword || alsoAccept.includes(POST.password)) ? ok(s) : send(res, form(`/${s}/login`, EMAIL + PASS, 'Sign in', 'Incorrect email or password'));
      }
      return authed(s) ? redirect(res, app(s)) : send(res, form(`/${s}/login`, EMAIL + PASS, 'Sign in'));
    }
    if (s === 'twostep') {
      if (step === 'login') return POST ? (POST.email === user ? redirect(res, '/twostep/password') : send(res, form('/twostep/login', EMAIL, 'Next', 'Couldn\'t find your account'))) : (authed(s) ? redirect(res, app(s)) : send(res, form('/twostep/login', EMAIL, 'Next')));
      if (step === 'password') { if (POST) { attempt(s); return POST.password === password ? ok(s) : send(res, form('/twostep/password', PASS, 'Sign in', 'Wrong password')); } return send(res, form('/twostep/password', PASS, 'Sign in')); }
    }
    if (s === 'totp') {
      if (step === 'login') { if (POST) return POST.email === user && POST.password === password ? redirect(res, '/totp/code') : send(res, form('/totp/login', EMAIL + PASS, 'Sign in', 'Incorrect email or password')); return authed(s) ? redirect(res, app(s)) : send(res, form('/totp/login', EMAIL + PASS, 'Sign in')); }
      if (step === 'code') { const f = '<input type="text" name="code" autocomplete="one-time-code" inputmode="numeric" placeholder="6-digit code">'; if (POST) { attempt(s); return POST.code === totp(totpCfg) ? ok(s) : send(res, form('/totp/code', f, 'Verify', 'Invalid code')); } return send(res, form('/totp/code', f, 'Verify')); }
    }
    if (s === 'captcha') {
      if (step === 'login') { if (POST) return POST.email === user && POST.password === password ? redirect(res, '/captcha/check') : send(res, form('/captcha/login', EMAIL + PASS, 'Sign in', 'Incorrect email or password')); return authed(s) ? redirect(res, app(s)) : send(res, form('/captcha/login', EMAIL + PASS, 'Sign in')); }
      if (step === 'check') { if (POST) return ok(s); return send(res, page('Security check', '<h1>Verify you are human</h1><form method="POST"><button type="submit" id="human">I\'m not a robot</button></form>')); }
    }
    if (s === 'phish') {
      if (step === 'login') return send(res, page('Redirecting', `<script>location.href='http://127.0.0.1:${port}/phish/evil'</script>`));
      if (step === 'evil') { if (POST) return send(res, page('thanks', 'gotcha')); return send(res, form('/phish/evil', EMAIL + PASS, 'Sign in')); }
    }
    send(res, page('404', 'nope'), 404);
  });

  return new Promise((resolve) => server.listen(0, () => resolve({ port: server.address().port, log, close: () => server.close() })));
}
