# Changelog

## 1.2.1 (second audit)

Fixed
- Secrets were decrypted (and password managers called, approval asked, uses counted) on every `open`, even when a saved session made typing unnecessary. Now lazy: only at the moment a credential is typed.
- OS helper programs (PowerShell for the DPAPI key and every approval dialog, osascript, security, ...) were found via PATH, and the agent-browser binary could be redirected by `HALLPASS_AB_BIN` or PATH. Now absolute system paths; no override; agent-browser path pinned.
- An agent could run `remove`, `add --force` (clearing lockout/limits) and could not be stopped from replacing a credential. These now need a terminal.
- A typed password stayed readable in SPA fields after a rejected attempt (`get value`). Fields are cleared; the MCP tool refuses password reads.
- Approval dialog focus started on "Allow once": a stray Enter/Space approved. Focus now starts on Deny; Esc denies.
- The one-time credential form URL was returned to the agent. Withheld when a window can be opened; one pending form per origin; rate limit.
- Gate holes: icon-only buttons (judged by id/class), `find last|nth`, `press`/`dialog` in `all` mode.
- Names starting with `site-` collided with saved-session profiles; now reserved.
- `via` reported "vault" even when nothing was typed.

Added
- `hallpass doctor` reports audit-chain health, the pinned agent-browser, and warns about weakening env overrides; `doctor --repin`.

## 1.2.0

Added
- **Per-use approval** (`add --require-approval`): a native dialog only the person can answer before a stored login is used; no GUI means deny. Allow once / for 1 hour (HMAC-signed grants).
- **Credential policy**: `--expires`, `--max-uses`.
- **Just-in-time credential entry**: `hallpass request <url>` / MCP `hallpass_request_credential`. A one-time local form (loopback, token + Host/Origin/CSRF checks, strict CSP) where the person types the login; the agent never sees it.
- **Password-manager references**: `--password-ref op://... | bw:<id> | pass:<path>`, `--totp-ref`. Pointers stored, secrets fetched at login time. Registration is terminal-only.
- **Action gate**: irreversible-looking clicks (delete, publish, pay, submit, ...) need a native confirmation, via the MCP `browser` tool and `hallpass do`. `HALLPASS_GATE=off|risky|all`.
- **Read-only mode** for the MCP server (`HALLPASS_READONLY=1`).
- **Audit log** (`hallpass log`): hash-chained, tamper-evident, no secrets.
- **Desktop notification** when a window needs the person.
- `hallpass sessions` / `prune`, passphrase-encrypted `export` / `import` (terminal-only), `init`, opt-in file keystore (`HALLPASS_KEYSTORE=file`).
- Localised detection (es, de, fr, pt, it, nl) and a 28-page detection test corpus.
- CI workflow (Windows, macOS, Linux). Unrun; see the note at the top of the file.

Fixed
- Repeated bad-password attempts across separate commands (now `credential_locked` until a person intervenes).
- `alive()` launched a blank browser for closed sessions; `resume`/`status` could misreport.
- Lost master key silently orphaned existing entries.
- `www`-to-apex redirects triggered false "sent somewhere else" handoffs.
- Stray email fields on logged-in pages could receive the username.
- Page-controlled text capped and sanitised before reaching the model.

## 1.1.0
- MCP server, per-tool instruction installers, MCP config snippets. Renamed from "keyhole" to Hallpass.

## 1.0.0
- Sealed vault (DPAPI), origin pinning, TOTP, redaction, headless login with human hand-off, `open` for any site.
