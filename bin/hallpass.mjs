#!/usr/bin/env node
// hallpass - let an agent USE credentials without ever being able to READ them.
// stdout is always one JSON document. Exit codes: 0 ok / logged_in, 10 needs_human, 1 failed, 2 usage.
import { parseArgs } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import * as vault from '../src/vault.mjs';
import { backend, masterKey } from '../src/keystore.mjs';
import { normalizeAllowed, parseOrigin } from '../src/origin.mjs';
import { parseTotpInput, base32Decode } from '../src/totp.mjs';
import { isTTY, ask, askHidden, readAllStdin } from '../src/prompt.mjs';
import { login, openSite, resume, status, logout, clearState } from '../src/login.mjs';
import { findBinary, TESTED_AGENT_BROWSER } from '../src/ab.mjs';
import { home } from '../src/paths.mjs';
import { install, mcpConfig, TARGETS, MCP_TARGETS } from '../src/install.mjs';
import { parseExpiry, resetUses, revokeGrant } from '../src/policy.mjs';
import { audit, readLog, verifyLog } from '../src/audit.mjs';
import { startCredentialRequest, describeRequest } from '../src/request.mjs';
import { runBrowser } from '../src/act.mjs';
import { exportVault, importVault } from '../src/portable.mjs';
import { listSessions, pruneSessions } from '../src/sessions.mjs';
import { parseRef, resolveRef, SecretUnavailable } from '../src/refs.mjs';
import { serve } from '../src/mcp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const out = (obj, code = 0) => { process.stdout.write(JSON.stringify(obj) + '\n'); process.exit(code); };
const usage = (msg) => out({ status: 'usage_error', message: msg }, 2);

const HELP = `hallpass - agent logins with credentials the agent can use but not read

  Run these in YOUR OWN terminal (they need a real keyboard):
    hallpass add <name> --url <login-url> [--origin <url>]... [options]
    hallpass add <name> ... --force          replace an existing entry
    hallpass remove <name>
    hallpass do <session> <command...>      run a browser command through the same guard + irreversible-action gate
    hallpass request <login-url> [--name n]  a PERSON enters a login in a one-time local form; safe for agents to start
    hallpass sessions                       saved browser sessions: age, size, running
    hallpass prune [--older-than 30d] [--dry-run]   forget saved sessions not used lately (credentials untouched)
    hallpass export <file> / import <file>  passphrase-encrypted backup to move machines (terminal only)
    hallpass init [--yes]                   detect your AI tools and set them up
    hallpass log [--tail n] [--verify]     what agents did with your logins (hash-chained, no secrets)
    hallpass unlock <name>                  re-enable auto-login after a rejected password

  The agent runs these:
    hallpass open <url> [--headed|--headless] [--as <name>]
                                            open ANY site. Stored credential for its origin -> headless login.
                                            None -> headless on a saved profile; if a login wall appears, a visible
                                            window opens and the person logs in. --headed forces person-logs-in mode.
    hallpass list                            names, URLs, approved origins (no secrets)
    hallpass show <name>                     metadata for one entry
    hallpass login <name> [--headed|--headless] [--wait <sec>] [--manual] [--timeout <sec>]
    hallpass resume <name> [--timeout <sec>] continue after a person solved a CAPTCHA / MFA
    hallpass status <name>
    hallpass logout <name> [--wipe]          close the browser (--wipe also deletes its profile)

  Setup:
    hallpass doctor
    hallpass harden                          print Claude Code deny-rules that fence off the vault
    hallpass install --for <tool>            teach an AI tool how to use hallpass. tool = claude | codex | gemini |
                                            antigravity | cursor | windsurf | copilot | agents | all
    hallpass mcp-config --for <tool>         print the MCP server config for: claude cursor gemini antigravity
                                            windsurf vscode codex   (then the tool gets hallpass_* and browser tools)
    hallpass mcp                             run as an MCP server over stdio (clients launch this themselves)
    hallpass install-skill [--dir <path>]    Claude-only shortcut for: install --for claude

  add options:
    --origin <url>            extra approved origin (repeatable), e.g. https://accounts.google.com or https://*.example.com
    --username-selector / --password-selector / --otp-selector / --submit-selector <css>
    --success-url <glob>      e.g. "https://app.example.com/**"  (strongly recommended)
    --success-text <text>     text that only appears when logged in
    --require-approval        every sign-in needs a native yes/no dialog that only the person can click (no GUI = deny)
    --expires <12h|30d|2w|date>   credential stops working after this
    --max-uses <n>            credential stops working after n sign-ins
    --lock-navigation         refuse navigation outside approved origins for the whole session
    --password-ref <ref>      use a password manager instead of storing the password: op://Vault/Item/field | bw:<item-id> | pass:<path>
    --totp-ref <ref>          same, for the one-time code; --username <u> to skip the username prompt (terminal only)
    --stdin-json              read {"username","password","totp"} from stdin (e.g. piped from a password manager)
`;

const [cmd, ...rest] = process.argv.slice(2);
if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') { process.stderr.write(HELP); process.exit(cmd ? 0 : 2); }

function opts(options, allowPositionals = true) {
  try { return parseArgs({ args: rest, options, allowPositionals, strict: true }); }
  catch (e) { return usage(e.message); }
}
const needName = (positionals) => { if (!positionals[0]) usage(`usage: hallpass ${cmd} <name>`); return positionals[0]; };
const mask = (u) => (u.includes('@') ? u[0] + '***@' + u.split('@')[1] : u.slice(0, 1) + '***');
const safe = (fn) => { try { return fn(); } catch (e) { return out({ status: 'failed', reason: 'error', detail: e.message }, 1); } };
const exitFor = (r) => out(r, r.status === 'logged_in' ? 0 : r.status === 'needs_human' ? 10 : 1);

switch (cmd) {
  case '--version': case '-v': case 'version': out({ name: 'hallpass', version: JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8')).version }); break;
  case 'add': {
    const { values: v, positionals } = opts({
      url: { type: 'string' }, origin: { type: 'string', multiple: true },
      'username-selector': { type: 'string' }, 'password-selector': { type: 'string' },
      'otp-selector': { type: 'string' }, 'submit-selector': { type: 'string' },
      'success-url': { type: 'string' }, 'success-text': { type: 'string' },
      'lock-navigation': { type: 'boolean' }, 'stdin-json': { type: 'boolean' }, force: { type: 'boolean' },
      'require-approval': { type: 'boolean' }, expires: { type: 'string' }, 'max-uses': { type: 'string' },
      username: { type: 'string' }, 'password-ref': { type: 'string' }, 'totp-ref': { type: 'string' },
    });
    const name = needName(positionals);
    if (!vault.validName(name)) usage('name must be lowercase letters, digits, . _ - (max 63)');
    if (!v.url) usage('--url is required (the login page)');
    const loginOrigin = parseOrigin(v.url);
    if (!loginOrigin) usage('--url must be https:// (http:// only for localhost)');
    if (vault.exists(name) && !v.force) usage(`"${name}" already exists. Use --force to replace it.`);
    if (vault.exists(name) && !isTTY()) usage('replacing an existing credential needs a real terminal: it also clears lockout, approval grants and use limits, so a person must do it.');
    if (name.startsWith('site-')) usage('names starting with "site-" are reserved');

    const allowedSet = new Set([loginOrigin]);
    for (const o of v.origin ?? []) {
      const n = normalizeAllowed(o);
      if (!n) usage(`invalid --origin "${o}" (https only; wildcards must be https://*.domain.tld)`);
      allowedSet.add(n);
    }
    const allowed = [...allowedSet];

    let username, password, totpRaw = '', passwordRef = null, totpRef = null;
    if (v['password-ref'] || v['totp-ref']) {
      // Registering a reference is as sensitive as typing a password: it decides where a vaulted secret can be sent.
      if (!isTTY() || v['stdin-json']) usage('references (--password-ref/--totp-ref) can only be registered by a person in a real terminal.');
      passwordRef = v['password-ref'] || null;
      totpRef = v['totp-ref'] || null;
      for (const r of [passwordRef, totpRef].filter(Boolean)) if (!parseRef(r)) usage('unsupported or unsafe reference. Use op://Vault/Item/field, bw:<item-id>, or pass:<path> (letters, digits, space and _ . @ : + / ? = ~ - only).');
      try { if (passwordRef) resolveRef(passwordRef, 'password'); } catch (e) { usage('could not read the password reference: ' + (e instanceof SecretUnavailable ? e.message : 'unknown error')); }
      username = v.username || await ask('Username / email: ');
      password = 'reference-only'; // placeholder so the length check below is skipped for refs
    } else if (v['stdin-json']) {
      try { ({ username, password, totp: totpRaw = '' } = JSON.parse(await readAllStdin())); } catch { usage('--stdin-json expects {"username","password","totp"?}'); }
    } else {
      if (!isTTY()) usage('hallpass add needs a real terminal so the password is typed by you, not by the agent. Open your own terminal and run it there (or use --stdin-json to pipe from a password manager).');
      process.stderr.write(`Adding "${name}" - approved origins: ${allowed.join(', ')}\n`);
      username = await ask('Username / email: ');
      password = await askHidden('Password (hidden): ');
      if (password !== await askHidden('Confirm password:  ')) usage('passwords did not match');
      totpRaw = await askHidden('TOTP secret or otpauth:// URI (hidden, Enter to skip): ');
    }
    if (!username) usage('username is required');
    if (!passwordRef && (!password || password.length < 6)) usage('password must be at least 6 characters');

    let totpCfg;
    if (totpRaw) {
      try { totpCfg = parseTotpInput(totpRaw); base32Decode(totpCfg.secret); } catch (e) { usage('bad TOTP secret: ' + e.message); }
    }
    let expiresAt = null;
    if (v.expires) { expiresAt = parseExpiry(v.expires); if (!expiresAt) usage('--expires must look like 12h, 30d, 2w or an ISO date'); }
    const maxUses = v['max-uses'] ? Number(v['max-uses']) : null;
    if (v['max-uses'] && !(Number.isInteger(maxUses) && maxUses > 0)) usage('--max-uses must be a positive integer');
    const selectors = Object.fromEntries(Object.entries({
      username: v['username-selector'], password: v['password-selector'], otp: v['otp-selector'], submit: v['submit-selector'],
    }).filter(([, x]) => x));

    safe(() => vault.put(name, {
      url: v.url, allowed, userHint: mask(username), hasTotp: !!totpCfg || !!totpRef, source: passwordRef ? parseRef(passwordRef).kind : 'vault',
      selectors, successUrl: v['success-url'] || null, successText: v['success-text'] || null,
      lockNavigation: !!v['lock-navigation'], createdAt: new Date().toISOString(),
      requireApproval: !!v['require-approval'], expiresAt, maxUses,
    }, { username, ...(passwordRef ? { passwordRef } : { password }), ...(totpRef ? { totpRef } : {}), ...(totpCfg ? { totp: totpCfg } : {}) }));
    clearState(name); // a fresh credential gets a fresh chance
    resetUses(name); revokeGrant(name);
    audit('add', { name, origins: allowed.join(' ') });
    out({ status: 'saved', name, sealed_with: backend().name, user: mask(username), totp: !!totpCfg, allowed_origins: allowed,
      note: 'Secrets are encrypted at rest and cannot be read back with hallpass.' });
    break;
  }
  case 'list': out({ entries: safe(() => vault.list()) }); break;
  case 'show': { const { positionals } = opts({}); out({ name: positionals[0], ...safe(() => vault.meta(needName(positionals))) }); break; }
  case 'remove': {
    const { positionals } = opts({});
    const name = needName(positionals);
    if (!isTTY()) usage('hallpass remove needs a real terminal: it permanently deletes a stored login.');
    safe(() => vault.remove(name));
    clearState(name);
    try { logout(name, { wipe: true }); } catch { /* browser may not be running */ }
    out({ status: 'removed', name });
    break;
  }
  case 'login': {
    const { values: v, positionals } = opts({ headed: { type: 'boolean' }, headless: { type: 'boolean' }, manual: { type: 'boolean' }, wait: { type: 'string' }, timeout: { type: 'string' } });
    const name = needName(positionals);
    if (v.headed && v.headless) usage('choose --headed or --headless, not both');
    exitFor(await login(name, { headed: v.headless ? false : v.headed ? true : undefined, manual: v.manual, wait: v.wait && Number(v.wait), timeout: v.timeout && Number(v.timeout) }).catch((e) => ({ status: 'failed', reason: 'error', detail: e.message })));
    break;
  }
  case 'open': {
    const { values: v, positionals } = opts({ headed: { type: 'boolean' }, headless: { type: 'boolean' }, as: { type: 'string' }, wait: { type: 'string' }, timeout: { type: 'string' } });
    if (!positionals[0]) usage('usage: hallpass open <url> [--headed|--headless] [--as <credential>]');
    if (v.headed && v.headless) usage('choose --headed or --headless, not both');
    exitFor(await openSite(positionals[0], { mode: v.headed ? 'headed' : v.headless ? 'headless' : 'auto', as: v.as, wait: v.wait && Number(v.wait), timeout: v.timeout && Number(v.timeout) }).catch((e) => ({ status: 'failed', reason: 'error', detail: e.message })));
    break;
  }
  case 'resume': {
    const { values: v, positionals } = opts({ timeout: { type: 'string' } });
    exitFor(await resume(needName(positionals), { timeout: v.timeout && Number(v.timeout) }).catch((e) => ({ status: 'failed', reason: 'error', detail: e.message })));
    break;
  }
  case 'status': { const { positionals } = opts({}); out(safe(() => status(needName(positionals)))); break; }
  case 'logout': { const { values: v, positionals } = opts({ wipe: { type: 'boolean' } }); out(safe(() => logout(needName(positionals), { wipe: v.wipe }))); break; }

  case 'unlock': {
    const { positionals } = opts({});
    const name = needName(positionals);
    safe(() => vault.meta(name));
    if (!isTTY()) usage('hallpass unlock needs a real terminal: it re-enables automatic logins after a rejected password, so a person must do it.');
    if ((await ask(`Re-enable automatic login for "${name}"? Only do this if the password is now correct on the site. Type yes: `)).toLowerCase() !== 'yes') usage('cancelled');
    clearState(name);
    out({ status: 'unlocked', name });
    break;
  }
  case 'request': {
    // Safe for an agent to run: a PERSON types the credential into a one-time local form; the agent never sees it.
    const { values: v, positionals } = opts({ name: { type: 'string' }, ttl: { type: 'string' } });
    if (!positionals[0]) usage('usage: hallpass request <login-url> [--name <name>]');
    let req;
    try { req = await startCredentialRequest({ url: positionals[0], name: v.name, ttlSec: Number(v.ttl) || 600 }); }
    catch (e) { out({ status: 'failed', reason: 'cannot_start', detail: e.message }, 1); }
    process.stdout.write(JSON.stringify(describeRequest(req)) + '\n');
    const r = await req.wait();
    out(r, r.status === 'saved' ? 0 : 1);
    break;
  }
  case 'do': {
    // hallpass do <session> <agent-browser command...>   same guard + irreversible-action gate as the MCP browser tool
    const args = process.argv.slice(3);
    const session = args.shift();
    if (args[0] === '--') args.shift();
    if (!session || !args.length) usage('usage: hallpass do <session> <command...>   e.g. hallpass do hp-site-example.com click @e3');
    const r = runBrowser({ session, command: args });
    process.stdout.write(r.text + '\n'); // page output, like agent-browser itself (not JSON)
    process.exit(r.isError ? 1 : 0);
    break;
  }
  case 'sessions': out({ sessions: safe(() => listSessions()) }); break;
  case 'prune': {
    const { values: v } = opts({ 'older-than': { type: 'string' }, 'dry-run': { type: 'boolean' } }, false);
    out(safe(() => pruneSessions({ olderThan: v['older-than'] || '30d', dryRun: !!v['dry-run'] })));
    break;
  }
  case 'export': {
    // The only path that turns vault contents into portable bytes: a person, in a terminal, with a passphrase only they know.
    const { values: v, positionals } = opts({ force: { type: 'boolean' } });
    const file = positionals[0];
    if (!file) usage('usage: hallpass export <file>');
    if (!isTTY()) usage('hallpass export needs a real terminal: it writes your credentials (encrypted) to a file, so a person must do it.');
    if (fs.existsSync(file) && !v.force) usage(`${file} already exists (use --force)`);
    const p1 = await askHidden('Export passphrase (12+ chars, hidden): ');
    if (p1 !== await askHidden('Repeat passphrase:                    ')) usage('passphrases did not match');
    const bundle = safe(() => exportVault(p1));
    fs.writeFileSync(file, JSON.stringify(bundle), { mode: 0o600 });
    out({ status: 'exported', file, note: 'Encrypted with your passphrase. Without it the file is useless; with it, it contains all your logins: store it carefully.' });
    break;
  }
  case 'import': {
    const { values: v, positionals } = opts({ force: { type: 'boolean' } });
    const file = positionals[0];
    if (!file) usage('usage: hallpass import <file> [--force]');
    if (!isTTY()) usage('hallpass import needs a real terminal (it asks for the export passphrase).');
    let bundle;
    try { bundle = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { usage('cannot read that file'); }
    const pass = await askHidden('Export passphrase (hidden): ');
    out({ status: 'imported', ...safe(() => importVault(bundle, pass, { force: !!v.force })) });
    break;
  }
  case 'init': {
    // Detect installed AI tools and show (or, with --yes, apply) the user-level setup. Project-level rule files
    // (Cursor, Windsurf, Copilot, AGENTS.md) are written by running `hallpass install --for <tool>` inside a project.
    const { values: v } = opts({ yes: { type: 'boolean' } }, false);
    const h = process.env.HALLPASS_TARGET_HOME || os.homedir();
    const probes = { claude: '.claude', codex: '.codex', gemini: '.gemini', cursor: '.cursor', windsurf: '.codeium' };
    const detected = Object.entries(probes).filter(([, d]) => fs.existsSync(path.join(h, d))).map(([k]) => k);
    const userLevel = detected.filter((t) => ['claude', 'codex', 'gemini'].includes(t));
    const plan = detected.map((t) => ({ tool: t, instructions: `hallpass install --for ${t}`, mcp: MCP_TARGETS.includes(t) ? `hallpass mcp-config --for ${t}` : null, scope: userLevel.includes(t) ? 'user' : 'project (run inside a project)' }));
    const applied = v.yes ? userLevel.flatMap((t) => safe(() => install(t))) : [];
    out({ status: 'ok', detected, plan, applied, applied_note: v.yes ? 'User-level instructions installed. MCP configs are printed by mcp-config; they are never written for you.' : 'Dry run. Re-run with --yes to install the user-level instructions.' });
    break;
  }
  case 'log': {
    const { values: v } = opts({ tail: { type: 'string' }, verify: { type: 'boolean' } }, false);
    out(v.verify ? { chain: verifyLog() } : { entries: readLog({ tail: Number(v.tail) || 50 }), chain: verifyLog() });
    break;
  }
  case 'doctor': {
    const { values: dv } = opts({ repin: { type: 'boolean' } }, false);
    if (dv.repin) { // changes WHICH agent-browser receives your typed secrets: a person must do this
      if (!isTTY()) usage('hallpass doctor --repin needs a real terminal: it decides which program receives your typed secrets.');
      out({ status: 'repinned', agent_browser: safe(() => findBinary({ repin: true })) });
    }
    const checks = [];
    const add = (name, okk, detail) => checks.push({ name, ok: okk, detail });
    add('node >= 20', Number(process.versions.node.split('.')[0]) >= 20, process.versions.node);
    try { const bin = findBinary(); const r = spawnSync(bin, ['--version'], { encoding: 'utf8' }); const ver = /(\d+\.\d+)\.\d+/.exec(r.stdout || '')?.[1]; add('agent-browser', r.status === 0, `${(r.stdout || '').trim()} (pinned: ${bin})`); add('agent-browser compatibility', true, ver === TESTED_AGENT_BROWSER ? `${ver}.x is the tested release line` : `NOTE: hallpass was tested with ${TESTED_AGENT_BROWSER}.x; you have ${ver || 'unknown'}. It may work, but report anything odd`); } catch (e) { add('agent-browser', false, e.message); }
    try { const b = backend(); const k = masterKey({ create: false }); add('keystore', true, `${b.name}; master key ${k ? 'present' : 'not created yet (created on first "hallpass add")'}`); } catch (e) { add('keystore', false, e.message); }
    add('home dir', true, home());
    try { const c = verifyLog(); add('audit log', c.ok, c.ok ? `${c.entries} entries, chain intact` : `TAMPERED or damaged at entry ${c.broken_at}: ${c.reason}`); } catch (e) { add('audit log', false, e.message); }
    // env vars that weaken a safety control for whoever sets them (an agent can set them on its own command line)
    const weak = [['HALLPASS_GATE', 'off', 'irreversible-action gate disabled'], ['HALLPASS_UPLOAD', 'allow', 'file uploads no longer need your approval (files are still vetted)'], ['HALLPASS_NO_UI', '1', 'no dialogs: approvals deny, notifications off'], ['HALLPASS_KEYSTORE', 'file', 'master key kept in a file, not the OS keystore']].filter(([k, v]) => process.env[k] === v);
    add('environment', true, weak.length ? 'NOTE: ' + weak.map(([k, v, why]) => `${k}=${v} (${why})`).join('; ') : 'no safety-relevant overrides set');
    out({ status: checks.every((c) => c.ok) ? 'ok' : 'problems', checks }, checks.every((c) => c.ok) ? 0 : 1);
    break;
  }
  case 'harden': {
    const h = home().replace(/\\/g, '/');
    out({
      note: 'Merge into ~/.claude/settings.json. Best-effort fence: stops the agent from casually opening the vault. The real guarantee is that hallpass has no command that prints a secret.',
      permissions: { deny: [
        `Read(${h}/**)`, `Edit(${h}/**)`, `Write(${h}/**)`, 'Read(~/.hallpass/**)', 'Edit(~/.hallpass/**)',
        'Bash(hallpass add:*)', 'Bash(*ProtectedData*)', 'Bash(*master.key*)', 'Bash(*.hallpass*)',
        'Bash(*find-generic-password*)', 'Bash(*secret-tool*)',
      ] },
    });
    break;
  }
  case 'mcp': serve(); break; // stdio MCP server; stays alive until the client closes stdin
  case 'install': {
    const { values: v } = opts({ for: { type: 'string' } }, false);
    if (!v.for) usage('usage: hallpass install --for <' + [...Object.keys(TARGETS), 'all'].join('|') + '>');
    out({ status: 'installed', results: safe(() => install(v.for)), next: 'Also run: hallpass mcp-config --for <tool>  to connect the MCP server (optional, recommended for IDE agents).' });
    break;
  }
  case 'mcp-config': {
    const { values: v } = opts({ for: { type: 'string' }, npx: { type: 'boolean' } }, false);
    if (!v.for) usage('usage: hallpass mcp-config --for <' + MCP_TARGETS.join('|') + '> [--npx]');
    out(safe(() => mcpConfig(v.for, { npx: !!v.npx })));
    break;
  }
  case 'install-skill': {
    const { values: v } = opts({ dir: { type: 'string' } }, false);
    const dest = path.join(v.dir || path.join(os.homedir(), '.claude', 'skills'), 'hallpass');
    fs.mkdirSync(dest, { recursive: true });
    fs.copyFileSync(path.join(HERE, '..', 'skills', 'hallpass', 'SKILL.md'), path.join(dest, 'SKILL.md'));
    out({ status: 'installed', path: path.join(dest, 'SKILL.md') });
    break;
  }
  default: usage(`unknown command "${cmd}". Run: hallpass help`);
}
