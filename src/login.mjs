// The login engine. This is the ONLY module that decrypts credentials, and it never returns them:
// every value that leaves this file has been through the Redactor, and page text is never returned.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as vault from './vault.mjs';
import { Browser } from './ab.mjs';
import { probeScript, tagSel } from './probe.mjs';
import { Redactor } from './redact.mjs';
import { isAllowed, safeUrl as rawSafeUrl, globToRegExp, parseOrigin, sameSite } from './origin.mjs';
import { totp, secondsLeft, parseTotpInput } from './totp.mjs';
import { profilesDir, stateDir } from './paths.mjs';
import { checkEligibility, authorizeUse } from './policy.mjs';
import { audit } from './audit.mjs';
import { notify } from './ui.mjs';
import { resolveSecrets, resolveRef, looksLikeCode, SecretUnavailable } from './refs.mjs';

// Everything that flows back to the model and originates from the page is untrusted text: cap it, strip control chars.
const safeUrl = (u) => rawSafeUrl(u).slice(0, 200);
const clean = (s, n = 80) => String(s || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const sessionName = (name) => `hp-${name}`;

// "https://*.a.com" -> "*.a.com", "https://b.com:8443" -> "b.com" (agent-browser --allowed-domains syntax)
const toDomain = (a) => (a.startsWith('https://*.') ? '*.' + a.slice('https://*.'.length).replace(/:\d+$/, '') : new URL(a).hostname);

// ---------- run context ----------
// Profile/session key for a site that has no vault entry. Human logins persist here, so later headless
// opens of the same site reuse the session without any stored credential.
export const siteKey = (url) => ('site-' + new URL(url).hostname).replace(/[^a-z0-9.-]/gi, '-').toLowerCase().slice(0, 63);

function makeCtx(name, o) {
  if (!vault.exists(name)) return makeGeneric(name, o);
  // Secrets are NOT loaded here. They are decrypted (and any password manager asked) only when a credential must
  // actually be typed, after policy/approval: see ctx.authorize().
  const ctx = buildCtx(name, vault.meta(name), null, new Redactor(), o);
  ctx.authorize = authorizer(ctx, o);
  return ctx;
}

function authorizer(ctx, o) {
  let done = false;
  return async () => {
    if (done) return null;
    if (!ctx.preAuthorized) {
      const pol = authorizeUse(ctx.name, { target: ctx.openUrl || o.target || ctx.meta.url, approver: o._approver });
      if (pol) return pol;
    }
    try { ctx.secrets = resolveSecrets(vault.unseal(ctx.name)); } // may call a password manager CLI
    catch (e) {
      if (e instanceof SecretUnavailable) return { status: 'failed', name: ctx.name, session: ctx.session, reason: 'secret_unavailable', detail: e.message };
      throw e;
    }
    ctx.redactor.add(ctx.secrets.password);
    if (ctx.secrets.totp) ctx.redactor.add(ctx.secrets.totp.secret);
    ctx.authorizedAt = new Date().toISOString();
    done = true;
    return null;
  };
}

// No vault entry: nothing to decrypt, nothing will ever be typed.
function makeGeneric(key, o) {
  let url = o.url;
  if (!url) { try { url = JSON.parse(fs.readFileSync(path.join(stateDir(), key + '.json'), 'utf8')).url; } catch { /* none */ } }
  if (!url) throw new Error(`no credential or open site named "${key}" (try: hallpass open <url>)`);
  const meta = { url, allowed: [new URL(url).origin], selectors: {}, successUrl: null, successText: null };
  return buildCtx(key, meta, null, new Redactor(), o, true);
}

const writeState = (ctx, phase, extra = {}) =>
  fs.writeFileSync(path.join(stateDir(), ctx.name + '.json'), JSON.stringify({ phase, url: rawSafeUrl(ctx.openUrl || ctx.meta.url), human: !!ctx.humanMode, at: new Date().toISOString(), ...(ctx.authorizedAt ? { authorizedAt: ctx.authorizedAt } : {}), ...extra }));

function buildCtx(name, meta, secrets, redactor, o, generic = false) {
  const ctx = {
    generic, name, meta, secrets, redactor, o,
    allowed: meta.allowed,
    authorize: async () => null, // credential-less contexts never need secrets
    nonce: crypto.randomBytes(8).toString('hex'),
    session: sessionName(name),
    profile: path.join(profilesDir(), name),
    trace: [],
  };
  ctx.reset = () => { ctx.st = { fills: { user: 0, pass: 0, otp: 0 }, filledAny: false, stable: 0, idle: 0, capSeen: 0, wallSeen: 0, nullProbes: 0, blank: 0, badFills: 0, lastFill: null }; };
  ctx.reset();
  ctx.mk = (headed) => new Browser({
    session: ctx.session, profile: ctx.profile, headed, redactor,
    allowedDomains: meta.lockNavigation ? meta.allowed.map(toDomain) : null,
  });
  return ctx;
}

const note = (ctx, msg) => { ctx.trace.push(`${new Date().toISOString().slice(11, 19)} ${ctx.redactor.scrub(msg)}`); };
const base = (ctx) => ({ name: ctx.name, session: ctx.session, mode: ctx.browser?.headed ? 'headed' : 'headless' });

// via: vault = hallpass typed the credentials; human = the user logged in; session = an existing saved session / no login needed
const ok = (ctx, p) => ({
  status: 'logged_in', ...base(ctx), via: ctx.humanMode ? (ctx.walled ? 'human' : 'session') : (ctx.st.filledAny ? 'vault' : 'session'),
  url: safeUrl(p.url), title: clean(ctx.redactor.scrub(p.title || '')), use: `agent-browser --session ${ctx.session} snapshot -i`,
});
const LOCKING = new Set(['bad_credentials', 'bad_totp']);
const readState = (name) => { try { return JSON.parse(fs.readFileSync(path.join(stateDir(), name + '.json'), 'utf8')); } catch { return null; } };
export const clearState = (name) => { try { fs.rmSync(path.join(stateDir(), name + '.json')); } catch { /* none */ } };
const fail = (ctx, reason, detail) => (LOCKING.has(reason) && writeState(ctx, 'failed', { reason }), { status: 'failed', ...base(ctx), reason, detail: ctx.redactor.scrub(detail), trace: ctx.trace.slice(-8) });
const needsHuman = (ctx, reason) => {
  const hints = {
    captcha: 'A CAPTCHA / bot check is showing.',
    mfa: 'The site wants a second factor that hallpass cannot supply (push approval, SMS/email code, security key).',
    mfa_code: 'The site wants a verification code and this entry has no TOTP secret.',
    unknown_page: 'hallpass does not recognise this page.',
    login: 'This site needs the user to log in.',
    redirected: `The site sent us to ${ctx.landed} instead of the page requested (${safeUrl(ctx.openUrl || '')}). That is typically a public landing page shown to logged-out visitors, so we are probably not logged in. If it is actually the right page, the user can just confirm.`,
  };
  ctx.keepFilled = true; // a person may be about to finish this form in the visible window
  writeState(ctx, 'needs_human', { reason });
  const where = ctx.browser?.headed ? 'A Chrome window is open on it.' : 'No window is open (headless): re-run without --headless to get a visible one.';
  return {
    status: 'needs_human', reason, ...base(ctx), url: safeUrl(ctx.last?.url || ''),
    message: `${hints[reason] || reason} ${where} Ask the user to complete it in that window, then run: hallpass resume ${ctx.name}`,
    resume: `hallpass resume ${ctx.name}`,
    trace: ctx.trace.slice(-6),
  };
};

// ---------- don't leave typed secrets lying in the page ----------
// A single-page app keeps the typed password in its field after a rejected attempt, and "get value" returns it in the
// clear to anyone driving the same browser. So when we are done typing, empty the secret fields (unless a person is
// mid-handoff in a visible window and may still need them).
const CLEAR_SCRIPT = "(() => { document.querySelectorAll('input[type=password], input[autocomplete=one-time-code]').forEach((i) => { i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); }); return JSON.stringify({ ok: true }); })()";
function scrubTypedSecrets(ctx) {
  try {
    if (!ctx || !ctx.st?.filledAny || ctx.keepFilled || !ctx.browser) return;
    if (!ctx.browser.alive()) return; // never launch a browser just to clean up
    ctx.browser.evalJson(CLEAR_SCRIPT);
    note(ctx, 'cleared typed secret fields');
  } catch { /* best effort */ }
}

// ---------- page probe ----------
function probe(ctx) {
  return ctx.browser.evalJson(probeScript({ nonce: ctx.nonce, selectors: ctx.meta.selectors || {}, successText: ctx.meta.successText || null }));
}

function differsFromLogin(ctx, url) {
  try {
    const a = new URL(url), b = new URL(ctx.meta.url);
    return a.origin !== b.origin || a.pathname.replace(/\/$/, '') !== b.pathname.replace(/\/$/, '');
  } catch { return true; }
}

async function totpCode(ctx) {
  if (ctx.secrets.totpRef) { // password manager supplies the current code (or the seed)
    const v = resolveRef(ctx.secrets.totpRef, 'totp').trim();
    ctx.redactor.add(v);
    if (looksLikeCode(v)) return v;
    const cfg2 = parseTotpInput(v);
    const code2 = totp(cfg2);
    ctx.redactor.add(code2);
    return code2;
  }
  const cfg = ctx.secrets.totp;
  const left = secondsLeft(cfg);
  if (left < 4) await sleep((left + 1) * 1000); // never submit a code that is about to expire
  const code = totp(cfg);
  ctx.redactor.add(code); // a one-time code echoed back by any tool is still scrubbed
  return code;
}

async function fill(ctx, p, kinds) {
  const st = ctx.st;
  const cmds = [];
  for (const k of kinds) {
    const value = k === 'user' ? ctx.secrets.username : k === 'pass' ? ctx.secrets.password : await totpCode(ctx);
    cmds.push(['fill', tagSel(ctx.nonce, k), value]);
  }
  cmds.push(p.submit === 'click' ? ['click', tagSel(ctx.nonce, 'submit')] : ['press', 'Enter']);
  const r = ctx.browser.batch(cmds);
  if (!r.ok) {
    st.badFills++;
    note(ctx, `fill ${kinds.join('+')} did not apply (page likely changed): ${String(r.error || '').slice(0, 120)}`);
    return;
  }
  for (const k of kinds) st.fills[k]++;
  st.filledAny = true;
  st.lastFill = { sig: sigOf(p), at: Date.now() };
  note(ctx, `filled ${kinds.join('+')} and ${p.submit === 'click' ? 'clicked submit' : 'pressed Enter'}`);
  await sleep(1200);
}

const sigOf = (p) => { try { return `${new URL(p.url).origin}${new URL(p.url).pathname}|${+p.user}${+p.pass}${+p.otp}`; } catch { return p.url; } };

// ---------- the state machine ----------
// wait=false: return needs_human as soon as a person is required.
// wait=true:  keep polling until the person is done (and carry on automating afterwards).
// noFill=true: never type anything; just watch for the logged-in state (manual login).
async function drive(ctx, { wait, deadline, noFill = false }) {
  const st = ctx.st;
  while (Date.now() < deadline) {
    const p = probe(ctx);
    if (!p) {
      // no answer from the page: closed window, crashed tab, or still navigating
      if (++st.nullProbes >= 12) return fail(ctx, 'browser_closed', 'The browser window was closed or stopped responding. Run hallpass open <url> again.');
      await sleep(700);
      continue;
    }
    st.nullProbes = 0;
    ctx.last = p;
    if (!/^https?:/i.test(p.url)) { // about:blank, chrome-error:// (site unreachable), ... is never a logged-in state
      if (++st.blank >= 6) return fail(ctx, 'page_unreachable', 'The browser is not showing a web page (blank, or a browser error page). The site may be unreachable or offline.');
      await sleep(1000);
      continue;
    }
    st.blank = 0;
    note(ctx, `probe ${safeUrl(p.url)} user=${+p.user} pass=${+p.pass} otp=${+p.otp} captcha=${+p.captcha} mfa=${+p.mfa} err=${+p.error}`);

    // Origin pinning only matters when something secret is about to be typed.
    if (!noFill && !isAllowed(p.url, ctx.allowed)) {
      if (!wait) return fail(ctx, 'origin_not_allowed', `The page is on ${safeUrl(p.url)}, which is not an approved origin for "${ctx.name}". Nothing was typed. If this is an expected SSO/IdP hop, re-add the entry with --origin for it.`);
      await sleep(1500); // a person is driving through an identity provider; never autofill there
      continue;
    }

    // A lone email/text box is only a login step when the page looks like a login, a password field is beside it,
    // we already submitted something, or the user told us its selector. Otherwise it is just a form on a logged-in page
    // (invite box, newsletter, search) and must never receive the username.
    const userStep = p.user && (p.loginish || p.pass || st.filledAny || !!ctx.meta.selectors?.username);
    const noFields = !userStep && !p.pass && !p.otp;
    // Credential-less opens have no "login URL" to compare with, so a login-looking URL/page is the signal instead.
    const urlOk = ctx.meta.successUrl ? globToRegExp(ctx.meta.successUrl).test(safeUrl(p.url))
      : ctx.humanMode ? !p.loginish
      : (st.filledAny || differsFromLogin(ctx, p.url));
    if (!p.captcha && !p.mfa && (p.successText === true || (noFields && urlOk && p.successText !== false))) {
      // SPAs often paint a blank shell before redirecting to /login, so human-mode opens demand a longer calm period
      if (++st.stable >= (ctx.humanMode ? 3 : 2)) {
        // Logged-out visitors are often bounced to a different site's marketing page (Play Console -> google.play/business).
        // Landing on another origin than the one requested is not proof of a session: ask the person to confirm.
        // (After the person has acted - wait mode - we accept wherever they ended up.)
        if (ctx.humanMode && !wait && ctx.openUrl && !sameSite(p.url, ctx.openUrl)) {
          ctx.landed = safeUrl(p.url);
          return needsHuman(ctx, 'redirected');
        }
        return ok(ctx, p);
      }
      await sleep(1200);
      continue;
    }
    st.stable = 0;

    if (p.captcha) {
      if (++st.capSeen < 2) { await sleep(3000); continue; } // many bot checks (Turnstile, "just a moment") clear on their own
      if (!wait) return needsHuman(ctx, 'captcha');
      await sleep(2000);
      continue;
    }
    st.capSeen = 0;

    if (noFill) {
      // Human mode: never type. A login wall (fields, login-looking page, MFA) means "ask the person".
      const wall = userStep || p.pass || p.otp || p.mfa || p.loginish;
      if (wall) {
        ctx.walled = true;
        if (!wait && ++st.wallSeen >= 2) return needsHuman(ctx, p.mfa ? 'mfa' : 'login'); // 2 looks: don't trip on a transient redirect
      } else st.wallSeen = 0;
      await sleep(wall && !wait ? 1200 : 2000);
      continue;
    }

    if (p.error && st.filledAny && (p.pass || p.otp || userStep) && !wait) {
      return fail(ctx, 'bad_credentials', 'The site is showing an error after the credentials were submitted. Not retrying, to avoid locking the account. Check the stored username/password (hallpass add NAME --force).');
    }

    // let the page react to our last submit before touching it again
    if (st.lastFill && st.lastFill.sig === sigOf(p) && Date.now() - st.lastFill.at < 8000) { await sleep(800); continue; }

    if (p.otp) {
      if (!ctx.meta.hasTotp) { if (!wait) return needsHuman(ctx, 'mfa_code'); await sleep(2000); continue; }
      if (st.fills.otp >= 2) return fail(ctx, 'bad_totp', 'The one-time code was rejected twice. The TOTP secret may be wrong, or this prompt wants an email/SMS code instead.');
      { const denied = await ctx.authorize(); if (denied) return denied; }
      await fill(ctx, p, ['otp']);
    } else if (p.pass || userStep) {
      const kinds = [userStep && 'user', p.pass && 'pass'].filter(Boolean);
      const spent = kinds.find((k) => st.fills[k] >= 2);
      if (spent) return fail(ctx, spent === 'pass' ? 'bad_credentials' : 'form_loop', `The ${spent === 'pass' ? 'password' : 'username'} step appeared again after being submitted twice.`);
      { const denied = await ctx.authorize(); if (denied) return denied; }
      await fill(ctx, p, kinds);
    } else if (p.mfa) {
      if (!wait) return needsHuman(ctx, 'mfa');
      await sleep(2000);
    } else {
      st.idle++;
      if (st.idle >= 8) { if (!wait) return needsHuman(ctx, 'unknown_page'); st.idle = 0; }
      await sleep(1000);
    }
    if (st.badFills >= 5) return fail(ctx, 'fill_error', 'Could not apply the fill commands to the page repeatedly. The login form may be inside an iframe or use a custom control; add selectors with hallpass add --username-selector/--password-selector/--submit-selector.');
  }
  return fail(ctx, 'timeout', 'Gave up waiting for the login to complete.');
}

// ---------- single-flight lock ----------
function lock(name) {
  const f = path.join(stateDir(), name + '.lock');
  if (fs.existsSync(f)) {
    const pid = Number(fs.readFileSync(f, 'utf8'));
    let alive = false;
    try { process.kill(pid, 0); alive = pid !== process.pid; } catch { /* stale */ }
    if (alive) throw new Error(`another hallpass command is already running for "${name}" (pid ${pid})`);
  }
  fs.writeFileSync(f, String(process.pid));
  return () => { try { fs.rmSync(f); } catch { /* ignore */ } };
}

function openFailed(ctx, opened) {
  const why = clean(opened.json?.error || opened.error || opened.stderr || 'could not open the page', 200);
  ctx.browser.close(); // do not leave a dead session behind
  return fail(ctx, 'browser_error', why);
}

// ---------- public API ----------
async function loginImpl(name, o = {}) {
  const release = lock(name);
  let ctx;
  try {
    // A rejected password is never retried automatically, not even by a later command: repeated bad attempts
    // are exactly what locks real accounts. Only a human (add --force / unlock) clears this.
    const prev = readState(name);
    if (prev?.phase === 'failed' && LOCKING.has(prev.reason)) {
      return { status: 'failed', name, session: sessionName(name), reason: 'credential_locked', detail: `The last login for "${name}" was rejected (${prev.reason}), so hallpass will not try again until the credential is fixed. Ask the user to run: hallpass add ${name} --force   (or hallpass unlock ${name} if they fixed it on the site).` };
    }
    const pol = checkEligibility(name); // expiry only; approval / use-count / decryption wait until a credential is actually typed
    if (pol) return pol;
    ctx = makeCtx(name, o);
    const deadline = () => Date.now() + (o.timeout ?? 90) * 1000;
    ctx.browser = ctx.mk(o.headed === true || o.manual === true);
    const start = o.target || ctx.meta.url; // a deep link works too: the site bounces to its login and back
    const opened = ctx.browser.open(start);
    if (!opened.ok) return openFailed(ctx, opened);

    if (o.manual) {
      const r = await drive(ctx, { wait: true, noFill: true, deadline: Date.now() + (o.wait ?? 600) * 1000 });
      return r;
    }

    let r = await drive(ctx, { wait: false, deadline: deadline() });
    if (r.status === 'needs_human' && !ctx.browser.headed && o.headed !== false) {
      // Hand over: same profile, visible window, replay up to the challenge so the person lands right on it.
      note(ctx, 'handoff: relaunching headed');
      ctx.browser.close();
      ctx.browser = ctx.mk(true);
      ctx.reset();
      const again = ctx.browser.open(start);
      if (!again.ok) return fail(ctx, 'browser_error', again.error || again.stderr || 'could not open headed browser');
      r = await drive(ctx, { wait: false, deadline: deadline() });
    }
    if (r.status === 'needs_human' && o.wait) r = await drive(ctx, { wait: true, deadline: Date.now() + o.wait * 1000 });
    if (r.status === 'logged_in') {
      writeState(ctx, 'logged_in');
      // land on what the caller asked for, if the login bounced somewhere else
      if (o.target && safeUrl(r.url) !== safeUrl(o.target)) { ctx.browser.open(o.target); r.url = safeUrl(o.target); }
    }
    return r;
  } finally { scrubTypedSecrets(ctx); release(); }
}

// hallpass open <url>: works for any site, with or without a stored credential.
//   mode auto:     vault entry for this origin -> headless login. No entry -> headless attempt with the site's persistent
//                  profile; if a login wall appears, switch to a visible window and ask the person to log in.
//   mode headed:   visible window, the PERSON logs in (nothing is ever typed for them).
//   mode headless: never opens a window; a login wall is reported as needs_human.
async function openSiteImpl(url, o = {}) {
  if (typeof url === 'string' && !/^[a-z][a-z0-9+.-]*:\/\//i.test(url.trim())) {
    // bare "play.google.com/console" works; local dev servers default to http
    url = (/^(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?(\/|$)/i.test(url.trim()) ? 'http://' : 'https://') + url.trim();
  }
  const origin = parseOrigin(url);
  if (!origin) return { status: 'failed', reason: 'bad_url', detail: 'URL must be https:// (http:// only for localhost)' };
  const mode = o.mode || 'auto';
  if (o.as && !vault.exists(o.as)) return { status: 'failed', reason: 'no_such_credential', detail: `no credential named "${o.as}"` };
  const matches = o.as ? [o.as] : vault.findByUrl(url);
  if (matches.length > 1) {
    // Never guess which account to log in as: wrong guesses can lock accounts or act as the wrong identity.
    return { status: 'failed', reason: 'ambiguous_credential', candidates: matches, detail: `${matches.length} stored credentials match ${origin}. Ask the user which account, then re-run with --as <name> (or --headed to let the user log in).` };
  }
  const entry = matches[0] || null;
  if (entry && mode !== 'headed') return loginImpl(entry, { target: url, headed: mode === 'headless' ? false : undefined, timeout: o.timeout, wait: o.wait });

  const key = entry || siteKey(url);
  const release = lock(key);
  try {
    const ctx = makeCtx(key, { url });
    ctx.humanMode = true;
    ctx.openUrl = url;
    const deadline = () => Date.now() + (o.timeout ?? 60) * 1000;
    ctx.browser = ctx.mk(mode === 'headed');
    const opened = ctx.browser.open(url);
    if (!opened.ok) return openFailed(ctx, opened);
    let r = await drive(ctx, { wait: false, noFill: true, deadline: deadline() });
    if (r.status === 'needs_human' && !ctx.browser.headed && mode !== 'headless') {
      note(ctx, 'login wall: relaunching headed for the user');
      ctx.browser.close();
      ctx.browser = ctx.mk(true);
      ctx.reset();
      const again = ctx.browser.open(url);
      if (!again.ok) return fail(ctx, 'browser_error', again.error || again.stderr || 'could not open headed browser');
      r = await drive(ctx, { wait: false, noFill: true, deadline: deadline() });
    }
    if (r.status === 'needs_human' && o.wait) r = await drive(ctx, { wait: true, noFill: true, deadline: Date.now() + o.wait * 1000 });
    if (r.status === 'logged_in') writeState(ctx, 'logged_in');
    return r;
  } finally { release(); }
}

async function resumeImpl(name, o = {}) {
  const release = lock(name);
  let ctx;
  try {
    let prev = {};
    try { prev = JSON.parse(fs.readFileSync(path.join(stateDir(), name + '.json'), 'utf8')); } catch { /* none */ }
    ctx = makeCtx(name, {});
    ctx.humanMode = !!prev.human || ctx.generic;
    ctx.walled = prev.phase === 'needs_human'; // the person was asked to act, so a success now is "via human"
    // Typing credentials from resume is only a continuation of a login that passed policy moments ago.
    const continuation = !ctx.humanMode && prev.phase === 'needs_human' && Date.now() - Date.parse(prev.at) < 30 * 60 * 1000;
    const watchOnly = ctx.humanMode || !continuation;
    ctx.preAuthorized = !!(continuation && prev.authorizedAt && Date.now() - Date.parse(prev.authorizedAt) < 30 * 60 * 1000);
    ctx.browser = ctx.mk(true);
    if (!ctx.browser.alive()) return fail(ctx, 'no_session', `No open browser session for "${name}". Run: hallpass ${ctx.generic ? 'open <url>' : 'login ' + name}`);
    // human-mode sessions: the person is logging in, so we only watch; never type over them
    const r = await drive(ctx, { wait: true, noFill: watchOnly, deadline: Date.now() + (o.timeout ?? 600) * 1000 });
    if (r.status === 'logged_in') writeState(ctx, 'logged_in');
    return r;
  } finally { scrubTypedSecrets(ctx); release(); }
}

// every public entry point is logged (no secrets: names, origin+path, outcomes) and nudges the user when a window needs them
const audited = (event, fn) => async (...args) => {
  const r = await fn(...args);
  audit(event, { name: r.name, target: typeof args[0] === 'string' && /^https?:/i.test(args[0]) ? safeUrl(args[0]) : undefined, status: r.status, reason: r.reason, via: r.via, mode: r.mode, url: r.url });
  if (r.status === 'needs_human' && r.mode === 'headed') notify('Hallpass needs you', 'A browser window is waiting for you to sign in or complete a check.');
  return r;
};
export const login = audited('login', loginImpl);
export const openSite = audited('open', openSiteImpl);
export const resume = audited('resume', resumeImpl);

export function status(name) {
  const meta = vault.exists(name) ? vault.meta(name) : { allowed: null };
  const redactor = new Redactor();
  const b = new Browser({ session: sessionName(name), profile: path.join(profilesDir(), name), redactor });
  const alive = b.alive();
  let url = null;
  if (alive) url = safeUrl(b.run(['get', 'url']).json?.data?.url || '');
  let phase = null;
  try { phase = JSON.parse(fs.readFileSync(path.join(stateDir(), name + '.json'), 'utf8')); } catch { /* none */ }
  return { name, session: sessionName(name), browser_running: alive, url, last: phase, allowed_origins: meta.allowed };
}

export function logout(name, { wipe = false } = {}) {
  if (!vault.validName(name)) throw new Error('invalid name');
  const b = new Browser({ session: sessionName(name), profile: path.join(profilesDir(), name), redactor: new Redactor() });
  b.close();
  if (wipe) fs.rmSync(path.join(profilesDir(), name), { recursive: true, force: true });
  return { name, closed: true, profile_wiped: wipe };
}
