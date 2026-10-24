# Changelog

## 1.4.0 (end-to-end workflow audit: "publish my app to Play Console")

Fixed
- **File uploads were impossible.** The `browser` tool and `hallpass do` blocked `upload`, so an agent could open Play Console and fill forms but never attach an `.aab` or store screenshots. `upload <selector> <files...>` now works (including hidden file inputs), with strict file vetting and a per-batch native approval (`HALLPASS_UPLOAD=ask|allow|off`).
- Text to type could be refused or mangled: release notes or descriptions beginning with `--`, or with a prefix such as `Data:` / `file:`, were rejected by the command guard, and a lone `--json` / `--headed` would have been eaten by the CLI's flag parser. Typed text is now exempt from the flag/URL checks and travels over stdin when it starts with `-`.
- The action gate missed "Send 7 changes for review" (Play Console's real label); and it interrupted routine, reversible clicks such as "Create new release". Both corrected.

Added
- `screenshot [--full] [name.png]` through the browser tool, written to a private folder (the agent picks a name, never a path).
- A Play Console publishing playbook in the skill, and instructions about uploads for MCP clients.
- `hallpass doctor` flags `HALLPASS_UPLOAD=allow`. Tests: `test/upload.test.mjs` (vetting, guard, real-browser upload, dashes, screenshot, gate labels).

## 1.3.0 (packaging for open source)

Added
- Renamed the npm package to **hallpass-browser** (command stays `hallpass`).
- Native packages: **Claude Code plugin + marketplace** (`.claude-plugin/`, `.mcp.json`, `skills/`), **Codex plugin** (`.codex-plugin/`, `.agents/plugins/marketplace.json`), **Gemini CLI extension** (`gemini-extension.json`, `GEMINI.md`). Claude's manifests pass `claude plugin validate`; the Codex and Gemini packages follow the official docs but could not be run (no CLIs available).
- `hallpass install --for antigravity` now installs a real skill into `~/.gemini/config/skills/` (and the CLI's skills dir if present); `antigravity-project` installs into `.agents/skills`. Locations confirmed against a working Antigravity IDE install.
- `hallpass mcp-config --for <tool> --npx` prints the `npx -y hallpass-browser mcp` form; the Antigravity entry now points at `~/.gemini/config/mcp_config.json`.
- `bin/hallpass` launcher so the command is on PATH when installed as a Claude Code plugin.
- MIT `LICENSE`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, vulnerability-reporting policy, issue/PR templates, Dependabot, and a release workflow with npm provenance (unrun).
- `hallpass doctor` notes when agent-browser is outside the tested release line.
- Packaging tests: manifest consistency, `claude plugin validate`, `npm pack` contents.

Changed
- `skill/` moved to `skills/` (the layout all three plugin systems expect).

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
