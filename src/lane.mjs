// Parallel lanes: seed a lane's own Chrome profile from the base login so it starts signed in.
// A lane is a COPY of the cookies and storage taken once, when the lane is first created. After that the two profiles live separate
// lives. No secret is read or printed here: files are copied byte for byte, never opened.
import fs from 'node:fs';
import path from 'node:path';
import { profilesDir } from './paths.mjs';

// Chrome's lock files and caches: a lock copied from a running profile makes Chrome think another instance owns the folder, and
// caches are large and rebuilt on demand.
const SKIP = /^(Singleton(Lock|Cookie|Socket)|lockfile|LOCK|.*\.lock|Cache|Code Cache|GPUCache|GrShaderCache|ShaderCache|DawnCache|Crashpad|BrowserMetrics.*|CacheStorage|Service Worker|component_crx_cache|optimization_guide.*)$/i;

function copyTree(src, dst, stats) {
  fs.mkdirSync(dst, { recursive: true, mode: 0o700 });
  let ents;
  try { ents = fs.readdirSync(src, { withFileTypes: true }); } catch { stats.failed++; return; }
  for (const e of ents) {
    if (SKIP.test(e.name) || e.isSymbolicLink()) continue;
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copyTree(s, d, stats);
    else {
      try { fs.copyFileSync(s, d); stats.copied++; } catch { stats.failed++; } // a file Chrome holds open on Windows cannot be read
    }
  }
}

/**
 * Create the lane profile `laneName` from `baseName` if it does not exist yet. Returns:
 *   { created: false }                       the lane already has a profile: left alone
 *   { created: true, seeded, copied, failed } seeded = the base had a profile and its cookie store copied cleanly
 * A lane that could not be seeded (no base login yet, or Chrome holds the base cookie store open) simply starts empty; the normal
 * login flow (stored credential, or the person signing in) then runs in the lane.
 */
export function seedLane(baseName, laneName) {
  const src = path.join(profilesDir(), baseName), dst = path.join(profilesDir(), laneName);
  if (fs.existsSync(dst)) return { created: false };
  if (!fs.existsSync(src)) { fs.mkdirSync(dst, { recursive: true, mode: 0o700 }); return { created: true, seeded: false, copied: 0, failed: 0 }; }
  const stats = { copied: 0, failed: 0 };
  copyTree(src, dst, stats);
  // Chrome keeps cookies in Default/Network/Cookies (older: Default/Cookies); without one the lane has nothing to carry over
  const hasCookies = ['Default/Network/Cookies', 'Default/Cookies'].some((f) => fs.existsSync(path.join(dst, ...f.split('/'))));
  const seeded = hasCookies && stats.failed === 0;
  // A half-copied profile (Chrome held some files open) can be inconsistent: start the lane clean instead.
  if (!seeded) { fs.rmSync(dst, { recursive: true, force: true }); fs.mkdirSync(dst, { recursive: true, mode: 0o700 }); }
  return { created: true, seeded, copied: seeded ? stats.copied : 0, failed: stats.failed };
}
