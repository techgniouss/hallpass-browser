// Running browser commands on behalf of an agent, with three safety layers:
//   1. guard      a fixed allowlist of page commands; hallpass sessions only; http(s) URLs only
//   2. read-only  HALLPASS_READONLY=1 (set by the PERSON in the MCP client config) permits observation only
//   3. gate       clicks that look irreversible/outward-facing (Delete, Publish, Pay, Submit application, ...) need a
//                 native yes/no dialog that only the person can answer. No GUI available = denied.
//                 HALLPASS_GATE=off|risky|all  (default risky)
// The gate is a HEURISTIC on the visible label, not a proof: it catches the common dangerous buttons, not every one.
import path from 'node:path';
import { Browser } from './ab.mjs';
import { Redactor } from './redact.mjs';
import { profilesDir } from './paths.mjs';
import { ask } from './ui.mjs';
import { audit } from './audit.mjs';
import { safeUrl } from './origin.mjs';

export const ALLOWED = new Set(['open', 'click', 'dblclick', 'fill', 'type', 'press', 'keyboard', 'hover', 'focus', 'check', 'uncheck', 'select', 'scroll', 'scrollintoview', 'wait', 'snapshot', 'get', 'is', 'find', 'tab', 'back', 'forward', 'reload', 'dialog', 'drag', 'highlight']);
const LONG_FLAGS = new Set(['--full', '--annotate', '--exact', '--name', '--new-tab', '--text', '--url', '--load', '--interactive', '--compact', '--depth', '--selector']);
const SHORT_FLAGS = new Set(['-i', '-c', '-u', '-d', '-s']);
const BAD_SCHEME = /^\s*(file|javascript|data|chrome|chrome-extension|view-source|devtools|ftp):/i;
const SESSION_RE = /^hp-[a-z0-9][a-z0-9._-]{0,62}$/;

export function guardBrowser({ session, command }) {
  if (!SESSION_RE.test(session || '')) return 'session must be a hallpass session (hp-...) returned by hallpass_open';
  if (!Array.isArray(command) || !command.length || command.length > 24 || command.some((a) => typeof a !== 'string' || a.length > 4000)) return 'command must be a non-empty array of strings';
  if (!ALLOWED.has(command[0])) return `"${command[0]}" is not available through this tool (allowed: ${[...ALLOWED].join(' ')})`;
  for (const a of command.slice(1)) {
    if (a.startsWith('--') && !LONG_FLAGS.has(a.split('=')[0])) return `flag ${a.split('=')[0]} is not allowed`;
    if (/^-[A-Za-z]$/.test(a) && !SHORT_FLAGS.has(a)) return `flag ${a} is not allowed`;
    if (BAD_SCHEME.test(a)) return 'only http(s) URLs are allowed';
  }
  return null;
}

// ---- read-only ----
export const readOnly = () => process.env.HALLPASS_READONLY === '1';
const WRITE_VERBS = new Set(['click', 'dblclick', 'fill', 'type', 'press', 'keyboard', 'check', 'uncheck', 'select', 'drag', 'dialog']);
const FIND_ACTIONS_THAT_WRITE = new Set(['click', 'dblclick', 'fill', 'type', 'check', 'uncheck', 'select', 'hover-click']);
export function writesState(command) {
  if (WRITE_VERBS.has(command[0])) return true;
  if (command[0] === 'find') return command.slice(1).some((a) => FIND_ACTIONS_THAT_WRITE.has(a));
  return false;
}

// ---- gate ----
export const gateMode = () => { const m = (process.env.HALLPASS_GATE || 'risky').toLowerCase(); return ['off', 'risky', 'all'].includes(m) ? m : 'risky'; };
export const RISKY = /\b(submit|apply(?! (filter|filters|changes to view))|publish|release|roll ?out|deploy|promote|delete|remove|erase|destroy|terminate|drop|pay|purchase|buy|checkout|place order|order now|subscribe|upgrade|transfer|invite|revoke|disable|deactivate|send for (review|approval)|go live)\b/i;
// Stems matched as SUBSTRINGS in id/class/name/data-testid (catches deleteBtn, btn-remove, publish_release, ...).
export const RISKY_ATTR = /(delet|remov|destroy|erase|terminat|publish|release|rollout|deploy|promote|purchase|checkout|subscribe|upgrade|invite|revoke|deactivat|transfer|submit|pay(?!load)|buy)/i;
const CLICKY = new Set(['click', 'dblclick', 'check', 'uncheck', 'select', 'drag']);
const FIND_BY_SELECTOR = new Set(['first', 'last', 'nth']);

function clickTarget(command) {
  if (command[0] === 'find') {
    const loc = command[1];
    if (FIND_BY_SELECTOR.has(loc)) { // find first|last|nth <selector> <action>: no label in the command itself
      const sel = loc === 'nth' ? command[3] : command[2];
      const action = loc === 'nth' ? command[4] : command[3];
      return CLICKY.has(action) ? { ref: sel, uncertain: loc !== 'first' } : null; // last/nth: we cannot tell which element, so ask
    }
    const action = command[3];
    if (!CLICKY.has(action)) return null;
    const nameIdx = command.indexOf('--name');
    return { find: [command[2], nameIdx > 0 ? command[nameIdx + 1] : ''].join(' ') };
  }
  if (CLICKY.has(command[0])) return { ref: command[1] };
  if (command[0] === 'press' || command[0] === 'dialog') return { ref: null, keystroke: true }; // can submit/confirm; only gated in "all" mode
  return null;
}

// Returns { label, attrs }: what a person would read on the control, and the id/class/name/testid a developer gave it.
function labelFor(browser, t) {
  if (t.find !== undefined) return { label: t.find.toLowerCase().slice(0, 300), attrs: '' };
  if (!t.ref) return { label: '', attrs: '' };
  // one process, several lookups: visible text, accessible name, button value, title, and developer-chosen attributes
  const q = [['get', 'text', t.ref], ['get', 'attr', t.ref, 'aria-label'], ['get', 'attr', t.ref, 'value'], ['get', 'attr', t.ref, 'title'],
    ['get', 'attr', t.ref, 'id'], ['get', 'attr', t.ref, 'class'], ['get', 'attr', t.ref, 'name'], ['get', 'attr', t.ref, 'data-testid']];
  const r = browser.run(['batch'], { input: JSON.stringify(q), timeout: 25_000 });
  if (!Array.isArray(r.json)) return { label: '', attrs: '' };
  const pick = (i) => JSON.stringify(r.json[i]?.result ?? '').toLowerCase();
  return { label: [0, 1, 2, 3].map(pick).join(' ').slice(0, 300), attrs: [4, 5, 6, 7].map(pick).join(' ').slice(0, 300) };
}

const browserFor = (session) => new Browser({ session, profile: path.join(profilesDir(), session.slice(3)), redactor: new Redactor() });

/** Returns { isError, text }. `approver` is injectable for tests only. */
export function runBrowser({ session, command }, { approver = ask } = {}) {
  const bad = guardBrowser({ session, command });
  if (bad) return { isError: true, text: bad };
  if (readOnly() && writesState(command)) {
    audit('browser', { session, verb: command[0], decision: 'blocked-readonly' });
    return { isError: true, text: `This hallpass server is read-only (HALLPASS_READONLY=1), so "${command[0]}" is not permitted. You can still snapshot, read, scroll and navigate.` };
  }
  const b = browserFor(session);

  // Never read a password back out of the page: whatever hallpass (or the user) typed there would come back in the clear.
  if (command[0] === 'get' && command[1] === 'value' && command[2]) {
    const t = b.run(['get', 'attr', command[2], 'type'], { timeout: 15_000 });
    if (String(t.json?.data?.value ?? '').trim().toLowerCase() === 'password') { // the attribute's value only: the JSON also carries the page URL, which may contain the word
      audit('browser', { session, verb: 'get value', decision: 'blocked-password-field' });
      return { isError: true, text: 'Reading the value of a password field is not permitted. (Snapshots show it masked.)' };
    }
  }

  const mode = gateMode();
  const target = mode === 'off' ? null : clickTarget(command);
  if (target) {
    const { label, attrs } = labelFor(b, target);
    // "all" gates every click-like action and keystroke-submits; otherwise: risky words in what the person sees, risky stems
    // in what the developer named it, or a target we cannot identify (find last/nth) which we ask about rather than guess.
    const risky = mode === 'all' || target.uncertain === true || RISKY.test(label) || RISKY_ATTR.test(attrs);
    if (risky) {
      const where = safeUrl((b.run(['get', 'url'], { json: false, timeout: 15_000 }).stdout || '').trim());
      const shown = (label.trim() ? label : attrs).replace(/\s+/g, ' ').replace(/["{}\[\]\\]/g, '').replace(/\bresult\b|\btext\b/g, '').trim().slice(0, 90) || '(unlabelled control)';
      const choice = approver({
        title: 'Hallpass: confirm action',
        message: `Your AI tool wants to ${command[0]}:\n\n    ${shown}\n\non ${where || 'the current page'}\n\n${mode === 'all' ? 'Every click and keystroke action is gated.' : 'This looks irreversible or outward-facing (publish, delete, pay, submit, ...).'}\nApprove only if this is exactly what you asked for.`,
        buttons: [{ id: 'deny', label: 'Deny' }, { id: 'once', label: 'Allow this action' }],
        timeoutSec: process.env.HALLPASS_ACTOR === 'mcp' ? 45 : 120,
      });
      audit('gate', { session, verb: command[0], label: shown, url: where, decision: choice === 'once' ? 'allowed' : 'denied' });
      if (choice !== 'once') return { isError: true, text: 'Blocked: the user did not approve this action (denied, timed out, or no desktop dialog was available). Do not retry it. Explain to the user what you wanted to do and ask them to do it or to approve it.' };
    }
  }

  if (writesState(command)) audit('browser', { session, verb: command[0], decision: 'allowed' });
  const r = b.text(command);
  let body = [r.stdout, r.stderr].filter(Boolean).join('\n').trim() || (r.ok ? 'ok' : 'command failed');
  if (body.length > 40_000) body = body.slice(0, 40_000) + '\n[truncated]';
  return { isError: !r.ok, text: body };
}
