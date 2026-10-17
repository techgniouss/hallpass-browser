// Creates stand-ins for the `op`, `bw` and `pass` CLIs so reference resolution can be tested without real accounts.
// Behaviour is driven by env vars so a test controls exactly what the "password manager" returns:
//   HP_FAKE_PW, HP_FAKE_USER, HP_FAKE_TOTP   values to return;  HP_FAKE_FAIL=1  simulate "locked / not signed in"
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function makeFakeClis() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-fakebin-'));
  if (process.platform === 'win32') {
    const fail = 'if "%HP_FAKE_FAIL%"=="1" (echo vault is locked 1>&2 & exit /b 1)\r\n';
    fs.writeFileSync(path.join(dir, 'op.cmd'), `@echo off\r\n${fail}if /i "%~2"=="op://v/i/otp" (echo %HP_FAKE_TOTP%) else (echo %HP_FAKE_PW%)\r\n`);
    fs.writeFileSync(path.join(dir, 'bw.cmd'), `@echo off\r\n${fail}if /i "%~2"=="totp" (echo %HP_FAKE_TOTP%) else if /i "%~2"=="username" (echo %HP_FAKE_USER%) else (echo %HP_FAKE_PW%)\r\n`);
    fs.writeFileSync(path.join(dir, 'pass.cmd'), `@echo off\r\n${fail}echo %HP_FAKE_PW%\r\necho second-line-is-metadata\r\n`);
  } else {
    const fail = '[ "$HP_FAKE_FAIL" = 1 ] && { echo "vault is locked" >&2; exit 1; }\n';
    fs.writeFileSync(path.join(dir, 'op'), `#!/bin/sh\n${fail}[ "$2" = "op://v/i/otp" ] && echo "$HP_FAKE_TOTP" || echo "$HP_FAKE_PW"\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'bw'), `#!/bin/sh\n${fail}case "$2" in totp) echo "$HP_FAKE_TOTP";; username) echo "$HP_FAKE_USER";; *) echo "$HP_FAKE_PW";; esac\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'pass'), `#!/bin/sh\n${fail}echo "$HP_FAKE_PW"\necho second-line-is-metadata\n`, { mode: 0o755 });
  }
  return dir;
}
