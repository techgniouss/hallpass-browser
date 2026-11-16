// Native, human-only UI: approval dialogs, notifications, opening the user's own browser.
// Design rule: if a dialog cannot be shown, the answer is DENY. Nothing here can approve on a person's behalf.
// HALLPASS_NO_UI=1 disables all UI (dialogs deny, notifications and browser opening are skipped): for tests/headless CI.
import { spawn, spawnSync } from 'node:child_process';
import { sysExe } from './sysexe.mjs';

export const noUi = () => process.env.HALLPASS_NO_UI === '1';

const WIN_DIALOG = `
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class HpFg { [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr p); [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool f); [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h); [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId(); public static void Front(IntPtr h) { IntPtr fg = GetForegroundWindow(); uint a = GetWindowThreadProcessId(fg, IntPtr.Zero); uint b = GetCurrentThreadId(); if (a != b) AttachThreadInput(a, b, true); SetForegroundWindow(h); if (a != b) AttachThreadInput(a, b, false); } }'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[Console]::InputEncoding=[Text.Encoding]::UTF8
$j=[Console]::In.ReadToEnd()|ConvertFrom-Json
$f=New-Object System.Windows.Forms.Form
$f.Text=[string]$j.title; $f.TopMost=$true; $f.StartPosition='CenterScreen'; $f.FormBorderStyle='FixedDialog'
$f.MaximizeBox=$false; $f.MinimizeBox=$false; $f.ShowInTaskbar=$true
$n=@($j.buttons).Count; $bw=150; $w=[Math]::Max(540,16+($bw+8)*$n+8)
$f.ClientSize=New-Object System.Drawing.Size($w,250)
$l=New-Object System.Windows.Forms.Label; $l.Text=[string]$j.message; $l.AutoSize=$false
$l.Location=New-Object System.Drawing.Point(16,14); $l.Size=New-Object System.Drawing.Size(($w-32),170)
$l.Font=New-Object System.Drawing.Font('Segoe UI',10); $f.Controls.Add($l)
$script:choice=''
$x=$w-16
for($i=$n-1;$i -ge 0;$i--){
  $b=New-Object System.Windows.Forms.Button; $b.Text=[string]@($j.buttons)[$i].label; $b.Tag=[string]@($j.buttons)[$i].id
  $b.Size=New-Object System.Drawing.Size($bw,34); $x-=$bw; $b.Location=New-Object System.Drawing.Point($x,200); $x-=8
  $b.TabStop=$false   # no button holds keyboard focus, so a stray Enter/Space (typing in another window) answers nothing
  $b.Add_Click({ $script:choice=[string]$this.Tag; $f.Close() }); $f.Controls.Add($b)
  if($i -eq 0){ $script:def=$b }   # the first button is the safe one (Deny)
}
$f.CancelButton=$script:def   # Esc can only ever DENY; Enter/Space do nothing until a button is clicked
$t=New-Object System.Windows.Forms.Timer; $t.Interval=[int]$j.timeoutSec*1000; $t.Add_Tick({ $script:choice='timeout'; $f.Close() }); $t.Start()
$f.KeyPreview=$true; $f.Add_KeyDown({ if($_.KeyCode -eq 'Escape'){ $script:choice='deny'; $f.Close() } })  # Esc = deny
$f.Add_Shown({ $f.Activate(); $f.TopMost=$true; [HpFg]::Front($f.Handle); try { [System.Media.SystemSounds]::Exclamation.Play() } catch {} })  # audible cue: the dialog is easy to miss
[void]$f.ShowDialog()
[Console]::Out.Write($script:choice)`;

const WIN_NOTIFY = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[Console]::InputEncoding=[Text.Encoding]::UTF8
$j=[Console]::In.ReadToEnd()|ConvertFrom-Json
$n=New-Object System.Windows.Forms.NotifyIcon
$n.Icon=[System.Drawing.SystemIcons]::Information; $n.Visible=$true
$n.ShowBalloonTip(10000,[string]$j.title,[string]$j.message,[System.Windows.Forms.ToolTipIcon]::Info)
Start-Sleep -Seconds 11; $n.Dispose()`;

const enc = (s) => Buffer.from(s, 'utf16le').toString('base64');

// Why the last dialog did not approve. "null" from ask() used to mean denied, timed out, no UI and crashed alike, so a person
// who simply did not see the dialog looked like a person who refused. Reasons: denied | timeout | no_ui | error (| approved).
let last = null;
export const resetOutcome = () => { last = null; };
export const lastOutcome = () => last;
const outcome = (choice, reason, detail = '', secs = 0) => { last = { reason: choice ? 'approved' : reason, detail: String(detail).slice(0, 200), secs }; return choice; };

/** Default dialog wait. MCP calls block the server while the dialog is up, so the wait is shorter than for the CLI. */
export const approvalTimeoutSec = () => (process.env.HALLPASS_ACTOR === 'mcp' ? 90 : 120);

/**
 * Text for the agent when an approval was not given. Only a real click on Deny says "do not retry": a timeout or a dialog that
 * never showed is not a refusal, and telling the agent it was one is what made genuine approvals look like denials.
 */
export function explainNoApproval(what, site) {
  const o = last || { reason: 'denied' };
  // Only the person can lower the number of dialogs (it needs a real terminal); the agent may tell them the command, never run it.
  const cmd = `hallpass access trusted ${site || '<site>'} --for 30d`;
  const hint = ` If the user wants fewer of these prompts they can run this in their own terminal (you cannot run it): ${cmd}. Undo with: hallpass access ask.`;
  switch (o.reason) {
    case 'timeout':
      return `Not approved: the approval dialog got no answer within ${o.secs || 'the allowed'}s, so the user most likely did not see it (check the taskbar and other windows). This is NOT a refusal. Tell the user a dialog is waiting, ask them to say when they are ready, then retry the same ${what} once; the dialog will reappear.${hint}`;
    case 'no_ui':
      return `Not approved: no desktop dialog could be shown (no GUI, or UI disabled with HALLPASS_NO_UI). The user cannot approve this ${what} from here. Ask them to do it themselves, to run hallpass on a desktop session, or to waive the dialog on trusted sites.${hint}`;
    case 'error':
      return `Not approved: the approval dialog failed to run (${o.detail || 'unknown error'}), so the user was never asked. This is not a refusal. Tell the user, and ask them to run "hallpass doctor" or to do this ${what} themselves.`;
    default:
      return `Not approved: the user clicked Deny (or closed the dialog). Do not retry this ${what}. Explain to the user what you wanted to do and ask them to do it or to approve it.`;
  }
}

/** buttons: [{id,label}], first = safest default. Returns the chosen id, or null (denied / timed out / no UI): see lastOutcome(). */
export function ask({ title, message, buttons, timeoutSec = 120 }) {
  if (noUi()) return outcome(null, 'no_ui', 'UI disabled');
  const secs = Number(process.env.HALLPASS_APPROVAL_TIMEOUT_SEC) || timeoutSec; // may only SHORTEN waiting; cannot approve
  const wait = Math.min(secs, timeoutSec);
  notify('Hallpass: approval needed', `${title}. A dialog is waiting for you (check the taskbar).`);
  try {
    if (process.platform === 'win32') {
      const ps = sysExe('powershell');
      if (!ps) return outcome(null, 'no_ui', 'powershell not found');
      const r = spawnSync(ps, ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', enc(WIN_DIALOG)], {
        input: JSON.stringify({ title, message, buttons, timeoutSec: wait }), encoding: 'utf8', timeout: (secs + 15) * 1000, windowsHide: false,
      });
      if (r.error || r.status !== 0) return outcome(null, 'error', (r.stderr || '').trim().replace(/\s+/g, ' ') || (r.error && r.error.message) || `exit ${r.status}`);
      const id = (r.stdout || '').trim();
      if (buttons.some((b) => b.id === id)) return outcome(id, 'approved', '', wait);
      return outcome(null, id === 'timeout' ? 'timeout' : 'denied', id ? '' : 'dialog closed', wait);
    }
    if (process.platform === 'darwin') {
      const labels = buttons.map((b) => b.label).slice(0, 3);
      const script = 'on run argv\nset t to item 1 of argv\nset m to item 2 of argv\nset s to (item 3 of argv) as integer\nset bl to items 4 thru -1 of argv\n' +
        'try\nset r to display dialog m with title t buttons bl default button (last item of bl) giving up after s\nif gave up of r then return "__timeout"\nreturn button returned of r\non error\nreturn ""\nend try\nend run';
      const osa = sysExe('osascript');
      if (!osa) return outcome(null, 'no_ui', 'osascript not found');
      const r = spawnSync(osa, ['-e', script, title, message, String(secs), ...labels], { encoding: 'utf8', timeout: (secs + 15) * 1000 });
      const out = (r.stdout || '').trim();
      const hit = buttons.find((b) => b.label === out);
      if (r.status === 0 && hit) return outcome(hit.id, 'approved', '', wait);
      if (r.error || r.status !== 0) return outcome(null, 'error', (r.stderr || '').trim() || (r.error && r.error.message) || `exit ${r.status}`);
      return outcome(null, out === '__timeout' ? 'timeout' : 'denied', '', wait);
    }
    // Linux: two-choice (allow / deny) via zenity or kdialog
    const allow = buttons[buttons.length - 1], deny = buttons[0];
    for (const [name, args] of [
      ['zenity', ['--question', '--title', title, '--text', message, '--ok-label', allow.label, '--cancel-label', deny.label, '--timeout', String(secs)]],
      ['kdialog', ['--title', title, '--yes-label', allow.label, '--no-label', deny.label, '--yesno', message]],
    ]) {
      const cmd = sysExe(name);
      if (!cmd) continue; // not installed in a trusted location
      const r = spawnSync(cmd, args, { timeout: (secs + 15) * 1000 });
      if (r.error) continue;
      if (r.status === 0) return outcome(allow.id, 'approved', '', wait);
      return outcome(null, r.status === 5 ? 'timeout' : 'denied', '', wait); // zenity exits 5 when --timeout expires, 1 on Deny
    }
    return outcome(null, 'no_ui', 'no zenity or kdialog installed');
  } catch (e) { return outcome(null, 'error', e && e.message); }
}

/** Best-effort desktop notification (never blocks, never throws). */
export function notify(title, message) {
  if (noUi()) return;
  try {
    if (process.platform === 'win32') {
      const ps = sysExe('powershell');
      if (!ps) return;
      const p = spawn(ps, ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', enc(WIN_NOTIFY)], { stdio: ['pipe', 'ignore', 'ignore'], detached: true, windowsHide: true });
      p.stdin.end(JSON.stringify({ title, message }));
      p.unref();
    } else if (process.platform === 'darwin') {
      const osa = sysExe('osascript');
      if (!osa) return;
      spawn(osa, ['-e', 'on run argv\ndisplay notification (item 2 of argv) with title (item 1 of argv)\nend run', title, message], { stdio: 'ignore', detached: true }).unref();
    } else {
      const ns = sysExe('notify-send');
      if (ns) spawn(ns, [title, message], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
    }
  } catch { /* notifications are a courtesy */ }
}

/** Open a URL in the person's default browser (used only for hallpass's own localhost pages). */
export function openInDefaultBrowser(url) {
  if (noUi() || process.env.HALLPASS_NO_BROWSER === '1') return false;
  try {
    const [name, args] = process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    const cmd = sysExe(name);
    if (!cmd) return false;
    const p = spawn(cmd, args, { stdio: 'ignore', detached: true });
    p.on('error', () => {});
    p.unref();
    return true;
  } catch { return false; }
}
