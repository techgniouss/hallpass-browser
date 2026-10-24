// File upload and screenshot-to-file support for the browser tool.
//
// Uploading is how an agent publishes anything real (an .aab to Play Console, screenshots to a store listing, a CSV to a
// dashboard), but it is also the easiest way to walk a secret out of the machine: "upload ~/.ssh/id_rsa to this page".
// So every path is vetted here and a person approves each batch (act.mjs) unless they opted out in the client config.
//   - only a short allowlist of file types: app bundles, images, video, documents, archives, plain text
//   - never inside a dot-directory (.ssh, .aws, .config, .hallpass, browser profiles, .git ...), never OS secret stores
//   - symlinks are resolved first, so a link in a harmless folder cannot point at a vault
//   - text-like files are sniffed for private-key blocks
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { home } from './paths.mjs';

export const MAX_FILES = 20;
export const MAX_BYTES = 2 * 1024 ** 3;
export const UPLOAD_EXT = new Set(['aab', 'apk', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'heic', 'mp4', 'mov', 'webm', 'pdf', 'txt', 'csv', 'md', 'zip', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx']);
const TEXTLIKE = new Set(['txt', 'csv', 'md']);
const PRIVATE_KEY = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----|"private_key"\s*:/;

// The person's home folder and OS locations that hold other programs' secrets or state.
function fenced() {
  const h = os.homedir();
  const dirs = [home(), '/etc', '/proc', '/sys', '/dev', '/root/.ssh'];
  if (process.platform === 'darwin') dirs.push(path.join(h, 'Library'));
  if (process.platform === 'win32') for (const v of ['APPDATA', 'LOCALAPPDATA', 'ProgramData']) if (process.env[v]) dirs.push(process.env[v]);
  return dirs;
}

const inside = (p, dir) => { const r = path.relative(dir, p); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };
const realOrNull = (p) => { try { return fs.realpathSync.native(p); } catch { return null; } };
const mb = (n) => (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + ' MB';

/** Vets one path. Returns { ok:true, path, size } with the symlink-resolved absolute path, or { ok:false, error }. */
export function vetUploadFile(p, { cwd = process.cwd() } = {}) {
  if (typeof p !== 'string' || !p || p.length > 1000 || /[\u0000-\u001f]/.test(p)) return { ok: false, error: 'invalid file path' };
  if (p.startsWith('-')) return { ok: false, error: `"${p.slice(0, 40)}" looks like a flag, not a file path` };
  const real = realOrNull(path.resolve(cwd, p));
  if (!real) return { ok: false, error: `file not found: ${p.slice(0, 120)}` };
  let st;
  try { st = fs.statSync(real); } catch { return { ok: false, error: `cannot read ${p.slice(0, 120)}` }; }
  if (!st.isFile()) return { ok: false, error: `not a regular file: ${p.slice(0, 120)}` };
  if (st.size === 0) return { ok: false, error: `file is empty: ${path.basename(real)}` };
  if (st.size > MAX_BYTES) return { ok: false, error: `${path.basename(real)} is ${mb(st.size)}; the limit is ${mb(MAX_BYTES)}` };
  const name = path.basename(real);
  const ext = path.extname(name).slice(1).toLowerCase();
  if (!UPLOAD_EXT.has(ext)) return { ok: false, error: `".${ext || '(none)'}" files cannot be uploaded through hallpass (allowed: ${[...UPLOAD_EXT].join(' ')}). Credentials, keys and config files are deliberately excluded; the user can upload those by hand.` };
  if (real.split(path.sep).some((c) => c.startsWith('.') && c.length > 1)) return { ok: false, error: `${name} is inside a hidden/config folder, which hallpass will not upload from. Copy the file somewhere ordinary first.` };
  for (const d of fenced()) {
    const rd = realOrNull(d) || d;
    if (inside(real, rd)) return { ok: false, error: `${name} is inside a protected location and will not be uploaded.` };
  }
  if (TEXTLIKE.has(ext)) {
    const fd = fs.openSync(real, 'r');
    try { const b = Buffer.alloc(Math.min(st.size, 65536)); fs.readSync(fd, b, 0, b.length, 0); if (PRIVATE_KEY.test(b.toString('latin1'))) return { ok: false, error: `${name} appears to contain a private key and will not be uploaded.` }; }
    finally { fs.closeSync(fd); }
  }
  return { ok: true, path: real, size: st.size };
}

/** files: the argv after `upload <selector>`. Returns { files:[{path,size}] } or { error }. */
export function vetUploads(files, opts) {
  if (!files.length) return { error: 'usage: upload <selector> <file> [file...]   (selector: @ref or a CSS selector such as "input[type=file]")' };
  if (files.length > MAX_FILES) return { error: `at most ${MAX_FILES} files per upload` };
  const out = [];
  for (const f of files) {
    const v = vetUploadFile(f, opts);
    if (!v.ok) return { error: v.error };
    out.push({ path: v.path, size: v.size });
  }
  return { files: out };
}

export const describeFiles = (files) => files.slice(0, 8).map((f) => `    ${path.basename(f.path)}  (${mb(f.size)})`).join('\n') + (files.length > 8 ? `\n    ... and ${files.length - 8} more` : '');

// ---- screenshots written to disk ----
// A directory only this user can read; the agent may only choose a file NAME inside it, never a path.
export function outDir() {
  const d = process.env.HALLPASS_OUT || path.join(os.tmpdir(), 'hallpass-out');
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
}

/** Turns `screenshot [flags] [name]` into a command that writes inside outDir(). Returns { command, file }. */
export function screenshotCommand(command, now = Date.now()) {
  const flags = command.slice(1).filter((a) => a.startsWith('-'));
  const given = command.slice(1).find((a) => !a.startsWith('-'));
  let name = given ? path.basename(given).replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '') : '';
  if (!/\.(png|jpe?g)$/i.test(name)) name = (name || `shot-${now}`) + '.png';
  const file = path.join(outDir(), name);
  return { command: ['screenshot', ...flags, file], file };
}
