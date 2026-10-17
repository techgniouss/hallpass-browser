// Windows only: the real native approval dialog, answered by a separate process through UI Automation
// (i.e. the way a person answers it), plus the timeout path. Pops a dialog on screen for a few seconds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CHILD = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ask-child.mjs');
const skip = process.platform !== 'win32' || process.env.HALLPASS_SKIP_DIALOG_TEST === '1'; // needs an interactive desktop

const CLICK = `
$ErrorActionPreference='Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$root=[System.Windows.Automation.AutomationElement]::RootElement
$name=[System.Windows.Automation.AutomationElement]::NameProperty
$w=$null
for($i=0;$i -lt 90 -and -not $w;$i++){
  $w=$root.FindFirst([System.Windows.Automation.TreeScope]::Children,(New-Object System.Windows.Automation.PropertyCondition($name,'Hallpass: approve sign-in')))
  if(-not $w){ Start-Sleep -Milliseconds 500 }
}
if(-not $w){ Write-Error 'dialog never appeared' }
$b=$w.FindFirst([System.Windows.Automation.TreeScope]::Descendants,(New-Object System.Windows.Automation.PropertyCondition($name,$env:BTN)))
if(-not $b){ Write-Error 'button not found' }
# WinForms buttons expose no invoke pattern to UI Automation, so click where a person would
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class M { [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y); [DllImport("user32.dll")] public static extern void mouse_event(uint f,uint dx,uint dy,uint d,UIntPtr e); }'
$r=$b.Current.BoundingRectangle
[void][M]::SetCursorPos([int]($r.X+$r.Width/2),[int]($r.Y+$r.Height/2)); Start-Sleep -Milliseconds 250
[M]::mouse_event(2,0,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 60; [M]::mouse_event(4,0,0,0,[UIntPtr]::Zero)`;

function runChild(env) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CHILD], { env: { ...process.env, ...env } });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (err += d));
    p.on('close', () => resolve({ out: out.trim(), err }));
  });
}
const KEY = `
$ErrorActionPreference='Stop'
try {
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Windows.Forms
$root=[System.Windows.Automation.AutomationElement]::RootElement
$name=[System.Windows.Automation.AutomationElement]::NameProperty
$w=$null
for($i=0;$i -lt 90 -and -not $w;$i++){
  $w=$root.FindFirst([System.Windows.Automation.TreeScope]::Children,(New-Object System.Windows.Automation.PropertyCondition($name,'Hallpass: approve sign-in')))
  if(-not $w){ Start-Sleep -Milliseconds 500 }
}
if(-not $w){ Write-Error 'dialog never appeared' }
Start-Sleep -Milliseconds 800
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class FG { [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); }'
$h=[IntPtr][int]$w.Current.NativeWindowHandle
if ([FG]::GetForegroundWindow() -ne $h) { [Console]::Out.Write('NOTFG'); exit 3 }  # never type into some other app
[System.Windows.Forms.SendKeys]::SendWait($env:KEYS)
} catch { [Console]::Out.Write('ERR: ' + $_.Exception.Message); exit 1 }`;
function pressKeys(keys) {
  return new Promise((resolve) => {
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', Buffer.from(KEY, 'utf16le').toString('base64')], { env: { ...process.env, KEYS: keys } });
    let err = ''; p.stdout.on('data', (d) => (err += d)); p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => resolve({ code, err }));
  });
}

function click(label) {
  return new Promise((resolve) => {
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', Buffer.from(CLICK, 'utf16le').toString('base64')], { env: { ...process.env, BTN: label } });
    let err = ''; p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => resolve({ code, err }));
  });
}

for (const [label, expected] of [['Allow once', 'once'], ['Allow for 1 hour', 'hour'], ['Deny', 'deny']]) {
  test(`native dialog: clicking "${label}" returns "${expected}"`, { skip, timeout: 90_000 }, async () => {
    const child = runChild({});
    const c = await click(label);
    assert.equal(c.code, 0, c.err);
    const r = await child;
    assert.equal(r.out, expected, r.err);
  });
}

for (const [keys, label] of [['{ENTER}', 'Enter'], [' ', 'Space']]) {
  test(`native dialog: a stray ${label} keypress denies (focus defaults to Deny, never to an Allow button)`, { skip, timeout: 90_000 }, async (t) => {
    const child = runChild({});
    const k = await pressKeys(keys);
    if (k.code === 3) { await child; t.skip('the dialog was not the foreground window, so no keys were sent (they would have gone to another app)'); return; }
    assert.equal(k.code, 0, k.err);
    const r = await child;
    assert.equal(r.out, 'deny', r.err);
  });
}

test('native dialog: nobody answers -> times out as deny (null)', { skip, timeout: 60_000 }, async () => {
  const r = await runChild({ HALLPASS_APPROVAL_TIMEOUT_SEC: '3' });
  assert.equal(r.out, 'null', r.err);
});
