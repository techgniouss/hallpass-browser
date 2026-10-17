// Absolute paths for the operating-system programs hallpass trusts with secrets or with human approval
// (the DPAPI/keychain helpers and every dialog). They are NEVER looked up through PATH: otherwise an agent could run
//   PATH=/tmp/fake:$PATH hallpass login x
// and a fake powershell.exe/osascript would see the master key or simply answer "Allow" to an approval dialog.
import fs from 'node:fs';
import path from 'node:path';

const WIN_ROOT = fs.existsSync('C:\\Windows\\System32') ? 'C:\\Windows' : (process.env.SystemRoot || 'C:\\Windows'); // prefer the fixed location over an env var an agent could set
const WIN = {
  powershell: path.join(WIN_ROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  rundll32: path.join(WIN_ROOT, 'System32', 'rundll32.exe'),
};
const MAC = { osascript: '/usr/bin/osascript', security: '/usr/bin/security', open: '/usr/bin/open' };
const LINUX_DIRS = ['/usr/bin', '/bin', '/usr/local/bin'];

/** Absolute path of a trusted system program, or null if it is not installed. */
export function sysExe(name) {
  if (process.platform === 'win32') return fs.existsSync(WIN[name] || '') ? WIN[name] : null;
  if (process.platform === 'darwin') return MAC[name] && fs.existsSync(MAC[name]) ? MAC[name] : null;
  for (const d of LINUX_DIRS) { const p = path.join(d, name); if (fs.existsSync(p)) return p; }
  return null;
}
