# hallpass security model

Goal: an AI agent can **use** a credential to log in, but has no path to **read** it.
This document says exactly what that does and does not protect against. Read it before trusting the tool.

## What hallpass guarantees

| Property | How |
|---|---|
| No command prints a secret | The CLI has no `get`/`reveal`/`export`. `vault.unseal()` is called from one place (`login.mjs`) and its result never reaches stdout. |
| Entering secrets needs a human | `hallpass add` refuses to run without a real TTY and reads the password with echo off. The agent's shell has no TTY. (`--stdin-json` exists for piping from a password manager; whoever runs that already holds the secret.) |
| Secrets rest encrypted | AES-256-GCM per entry. The 256-bit master key is sealed by Windows DPAPI (CurrentUser), macOS Keychain, or libsecret, and is never written in the clear. |
| Entries cannot be quietly re-pointed | Approved origins and selectors are authenticated as GCM AAD. Editing `entries/<name>.json` to add an attacker origin makes the entry fail its integrity check. |
| Secrets only go to approved origins | Before each fill the page origin must match the origins approved at `add` time (https only, `localhost` exempt, wildcards are subdomain-only). A redirect to another origin (phishing, open redirect, compromised link) gets nothing: `failed: origin_not_allowed`. |
| No time-of-check/time-of-use gap | Fields are targeted through a per-run random attribute set during the probe. If the page navigates before the fill, the selector matches nothing and nothing is typed. A hostile page cannot pre-plant the attribute (unknown nonce). Hidden (honeypot) inputs are never selected. |
| Secrets do not appear in process listings | Passwords go to `agent-browser` over **stdin** (`batch`), not argv. |
| Output is scrubbed | All output from the browser is passed through a redactor that removes the password / TOTP seed in raw, JSON-escaped, URL-encoded and base64 forms. hallpass never returns page text; URLs are returned as origin + path only (no query/fragment, where tokens live). |
| No lockout loops | A rejected password is never retried. TOTP is retried once, and never submitted in the last 4 s of its window. |
| Human-only steps stay human | CAPTCHA and non-TOTP MFA return `needs_human`; hallpass does not try to solve or bypass them. |

Verified by `npm run test:e2e`, which logs in against a local site with a honeypot field, a phishing redirect, a wrong password, a TOTP step and a CAPTCHA, and then scans everything hallpass printed, every file in the vault, and agent-browser's own logs for the password and the TOTP seed.

### MCP specifics

| Property | How |
|---|---|
| No credential tool | The MCP server exposes no tool that adds, reads or exports secrets; credentials enter only via `hallpass add` in a human terminal. |
| Confined to hallpass's browsers | `browser` / `browser_screenshot` accept only `hp-*` sessions, so a model cannot steer your other agent-browser sessions. |
| Narrow command set | An allowlist of page commands; long flags allowlisted (blocks `--cdp`, `--proxy`, `--headers`, `--init-script`, `--profile`, ...); no `eval`, `cookies`, `storage`, `state`, `upload`, `download`, `network`. `file:`/`javascript:`/`data:`/`chrome:` URLs rejected. This stops a prompt-injected page from turning the model into a local-file reader or cookie exfiltrator *via this tool*. |
| Injection marking | Page content is returned inside `AGENT_BROWSER_PAGE_CONTENT nonce=...` markers. |
| Clean protocol | stdout carries only JSON-RPC; tool errors come back in-band. |

An agent that also has a general shell is not constrained by these limits (it can run `agent-browser` directly). They protect MCP-only clients and add defence in depth.

### Approval, policy, gate, entry, references

| Property | How |
|---|---|
| Human-only approval | `--require-approval` shows a native dialog (WinForms / osascript / zenity). The agent cannot click it; with no GUI or no answer the result is **deny**. Verified by a test that answers the real dialog with a physical click. 1-hour grants are HMAC-signed with a key derived from the vault master key. |
| Policy before decryption | Expiry, use limits and approval are checked before any secret is unsealed; they live in the entry's authenticated metadata. |
| Lockout protection | A rejected password/TOTP disables automatic login for that entry (`credential_locked`) across processes until a person clears it. |
| Action gate | In the MCP `browser` tool and `hallpass do`, controls whose label/aria-label/value/title match irreversible patterns (delete, publish, pay, submit, ...) need a native confirmation. Fail-closed. |
| Read-only | `HALLPASS_READONLY=1` on the MCP server permits observation only; set by the person in the client config. |
| Just-in-time entry | `hallpass request` serves a form on 127.0.0.1 only, behind a 256-bit one-time path, with Host + Origin checks (DNS-rebinding / cross-site posts), a CSRF token, strict CSP, no caching, an 8 KB cap, 5-minute-class expiry and single use. It refuses to overwrite an existing entry. |
| References | `--password-ref` stores a pointer; the secret is fetched at login and never stored. Reference strings are validated against a strict character set before any CLI call. **Registering a reference is terminal-only**, otherwise an agent could pin a password-manager item to an attacker origin. |
| Audit | `hallpass log` is a hash chain (edits, deletions, reordering are detectable; a same-user process can still delete the whole file). Contains names, origin+path, verbs, outcomes; never secrets. |
| Export | The only path that serialises vault contents. Terminal-only, scrypt + AES-256-GCM under a passphrase the person chooses. |

### Hardening added in the second audit

| Property | How |
|---|---|
| Secrets are used only when typed | Decryption, password-manager calls, approval dialogs and use-counting happen at the moment a credential must be typed. A still-valid saved session consumes no use, shows no dialog and touches no password manager. Expiry (metadata only) is checked up front. |
| The programs we trust cannot be swapped from the shell | The OS helpers that hold the master key or show approval dialogs (PowerShell, osascript, security, secret-tool, zenity, ...) are launched by **absolute system path**, never via PATH/cwd; a test forbids bare-name launches. There is **no** environment override for the agent-browser binary (it receives every typed secret), and its absolute path is **pinned** in `config.json` after first resolution; `hallpass doctor --repin` (terminal only) changes it. |
| Destructive/state-clearing commands need a person | `remove`, `unlock`, `add --force` over an existing entry, `export`, `import`, `doctor --repin` and registering a reference all require a real terminal. An agent can add a *new* login (`request`, or `add --stdin-json` for a new name) but cannot delete or overwrite yours, nor reset a lockout. |
| Typed secrets do not linger in the page | After typing, password / one-time-code fields are emptied (a single-page app otherwise keeps them after a rejected attempt, and `get value` returns them in the clear). The MCP `browser` tool also refuses `get value` on password fields. Snapshots mask them. |
| Approval dialog defaults to Deny | Focus starts on Deny and Esc denies, so a stray Enter or Space keypress while you type elsewhere cannot approve. Tested with real keypresses. |
| The one-time form URL is not handed to the agent | When a window could be opened for you, the agent is not told the URL (otherwise it could submit its own credential first and consume your form). One pending form per origin; at most 12 forms per 10 minutes. |
| Reserved names | Credential names starting with `site-` are refused: they would collide with the saved-session profile of credential-less sites. |
| Gate coverage | The action gate also reads `id`/`class`/`name`/`data-testid` (catches icon-only "trash" buttons), asks about `find last|nth` targets it cannot identify, and in `HALLPASS_GATE=all` gates `press` and `dialog` as well. |

## What hallpass does NOT protect against

Be honest with yourself about these.

- **You are the last line of defence on two prompts.** The credential form displays the origin a password will be pinned to, but the *agent chooses that URL*: read it. Likewise the approval dialog shows the target; do not approve sign-ins you did not start.
- **The action gate is a label heuristic.** A dangerous control with an innocuous label ("OK", "Continue") passes. Shell agents can skip it by calling `agent-browser` directly. Treat it as a seatbelt, not a cage.
- **A shell agent can run `agent-browser get value` on a password field in the short window between typing and the scrub** (or while a person is mid-handoff in a visible window, when fields are deliberately left filled). The MCP tool refuses this; direct shell access cannot be fenced.
- **Preloading code into hallpass itself** (e.g. `NODE_OPTIONS=--require evil.js hallpass login x`) runs arbitrary code as you inside the process that holds decrypted secrets. That is the same-user limit below, not something hallpass can detect or stop. `hallpass doctor` warns about safety-relevant `HALLPASS_*` overrides it can see.
- **The credential form is plain HTTP on loopback.** Other local processes of your user could in principle observe loopback traffic; a hostile local process is already outside this threat model (see next point).
- **`HALLPASS_KEYSTORE=file`** keeps the master key in a file next to the vault. Use it only where no OS keystore exists (containers, CI).
1. **A same-user process can decrypt the vault.** DPAPI/Keychain bind secrets to *your OS account*, not to "hallpass". An agent that is allowed to run arbitrary shell commands as you could, in principle, call the OS crypto API itself. hallpass removes the *easy and accidental* paths and the prompt-injection paths; it is not an OS sandbox. Mitigations, in order of strength:
   - Run the agent as a different OS user, or in a container/VM, with only the `hallpass` binary and the sealed vault reachable via a socket/sudo wrapper (not provided).
   - Add the deny rules from `hallpass harden` to Claude Code settings (best-effort string matching, not a boundary).
   - Keep high-value accounts (banking, root cloud accounts, registrars) out of the vault.
2. **The logged-in session is the agent's.** Once logged in, the agent can read cookies/localStorage (`agent-browser state save`, `eval`) and do anything the account can do. hallpass protects the *password and TOTP seed* (which allow persistent access from anywhere), not the *session*. Use least-privilege accounts, short-lived sessions (`hallpass logout --wipe`), and the confirmation rule in the skill for irreversible actions.
3. **Browser profiles hold session cookies** under `~/.hallpass/profiles/<name>` in Chrome's own format. Treat that directory like a logged-in browser.
4. **A TOTP seed in the vault weakens 2FA** into "something the agent's machine has". That is the trade-off for hands-free MFA; omit the TOTP secret for accounts where you want a human tap on every login.
5. **Compromised approved origins.** If an origin you approved (or a subdomain under a wildcard) serves attacker content, it can receive the credential. Prefer exact origins over wildcards.
6. **Login forms in iframes / shadow DOM / canvas** are not auto-detected (they fail closed: nothing is typed).
7. **macOS/Linux backends are untested.** Only Windows DPAPI is exercised by the test-suite. On macOS the master key is briefly visible in `security`'s argv once, at vault creation.
8. **Terms of service.** Some sites forbid automated logins. You are responsible for using this on accounts you own and where automation is permitted.

## Reporting

Open an issue with a reproduction. Do not include real credentials.

## Reporting a vulnerability

Please **do not open a public issue** for a security problem.

- Use GitHub's private vulnerability reporting: the repository's **Security → Report a vulnerability** button (maintainers: enable *Private vulnerability reporting* in the repository settings).
- Include: affected version (`hallpass --version`), OS, what an attacker or a careless agent can do, and a minimal reproduction. **Never include real credentials.**
- What counts: any path by which an agent (or a web page) can *read* a stored secret, make Hallpass type one into the wrong origin, bypass an approval dialog or the terminal-only rules, or read/forge the audit log undetectably. Weaknesses already listed under "What hallpass does NOT protect against" are known limits, not vulnerabilities, but improvements are welcome.
- Expect an acknowledgement within a few days and a coordinated fix and disclosure. This is a volunteer project; there is no bug bounty.

Supported versions: the latest release only (the project is pre-1.x-stable and moves quickly).

## Using this software safely

Hallpass is a beta, single-author tool that has **not been independently audited**. Do not use it for accounts whose compromise would be severe (banking, domain registrars, root cloud accounts) until it has been reviewed by people other than its author.
