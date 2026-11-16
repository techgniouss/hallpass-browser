# Changelog

## 1.6.1 (fix: genuine approvals reported as "denied")

Fixed
- **A missing approval is no longer reported as a refusal.** A dialog that timed out (you did not see it), could not be shown (no GUI) or failed to run all came back as "denied", so the agent gave up even when you would have said yes. The audit log of one real user showed denials spaced exactly 2 minutes apart: unseen dialogs hitting the 120 s timeout. Now `ask()` records why (`denied`, `timeout`, `no_ui`, `error`, with PowerShell's stderr), the audit log stores that reason, and the agent is told: only a real Deny means "do not retry"; a timeout means "tell the user a dialog is waiting and retry once". Sign-ins return `approval_timeout`, `approval_unavailable` or `approval_error` besides `approval_denied`.
- **Dialogs are harder to miss.** A desktop notification and a sound accompany every dialog, and the wait under MCP is 90 s (was 45 s; CLI stays 120 s).
- **A stray key can no longer answer a dialog.** No button holds keyboard focus (before, Deny did, so Enter/Space while typing elsewhere denied). Esc still denies; only a click answers.
- **Fewer needless prompts.** Opening an existing release ("Manage release 18"), the Play Console "Test and release" card and a CI run row ("release 4m 23s") no longer trigger the click gate. Publish, rollout, send for review and discard release still do.

Added
- **"Allow for 1 hour" on the click dialog**, for one site in one hallpass session, kept in memory only (never on disk) and audited as `allowed-grant`. It covers every risky click on that site until it expires, so use it deliberately.
- **Command hints for the agent.** When a dialog was not answered, blocked-action messages, the MCP instructions and `hallpass_access` now tell the agent it may give you the command to run in your own terminal (`hallpass access trusted <site> --for 30d`, undo `hallpass access ask`). The agent still cannot run it.
- **Delegation guidance.** A subagent cannot see your chat, so an approval you gave the main agent does not exist for it. The skill and MCP instructions say to copy the approval, scoped to the step, into the subagent's prompt; a subagent without one should report "needs user approval", not "denied".
- Tests: `test/approval-reasons.test.mjs` (reason codes, timeouts, classifier). The real-dialog tests now check that Enter/Space answer nothing.

Upgrading from 1.6.0: nothing to migrate. Scripts matching the old text "the user did not approve" should match "Not approved" instead.

## 1.6.0 (several accounts, watch mode, access levels, update notice)

Added
- **Update notice.** About once a day Hallpass asks the npm registry for the latest version number (anonymous, background, never blocks; off with `HALLPASS_NO_UPDATE_CHECK=1`, in CI and in tests). When a newer one exists, the next `open` result carries `update_available` (once per new version per day) so the agent asks you whether to update, `doctor` shows it, MCP `hallpass_version` and `hallpass update --check` let an agent look. `hallpass update` installs it only for you: real terminal, typed yes, and the right command for how it was installed (global npm, Claude Code plugin, Gemini extension, npx, git clone). Agents are told not to run it.
- **Access levels** (`hallpass access`): `ask` (default), `trusted <site>...` (no click/upload dialogs on the sites you list), `full` (everywhere; expires after 4 hours unless `--for` or `--forever`). Person-only (real terminal + typed yes); signed; expired, edited or unverifiable means `ask`. `--include-credentials` also waives the approval dialog of stored logins that ask each time (otherwise they keep asking); under `trusted` only when every origin the login may be typed on is a listed site. Never relaxed: secret redaction, origin pinning, blocked commands, upload vetting, read-only, `HALLPASS_UPLOAD=off`, expiry, use limits, lockouts, CAPTCHA hand-off. Waived dialogs are audited (`allowed-by-access`); `doctor` and every result show an active level; MCP `hallpass_access` lets the agent read (not change) it; `harden` fences the setting.
- **Multiple accounts per website, in both modes.** A site can now have any number of stored credentials *and* any number of saved browser logins (no password stored). `--as <x>` takes a credential name, a label for a saved login (`--as work`; a label hallpass has not seen starts a new, separate profile `site-<host>__work`), or `default` for the unlabelled login that already existed. Nothing changes for sites with a single login.
- **`hallpass accounts [<url>]`** and MCP **`hallpass_accounts`**: list every login for a site (or all sites): kind, `as` value, masked user, nickname, last used, locked state. Never a secret.
- **Never guess.** With several logins and no `--as`, `open` returns `ambiguous_account` with `candidates` and a `description` per account (replaces `ambiguous_credential`, which only covered stored credentials). The skill, MCP instructions, Gemini context and every installed rule file tell the agent to ask the user and repeat with `as`. MCP clients that support **elicitation** show the user a native picker instead (`account_chosen_by: "user"`); the answer must be one of the offered accounts. `HALLPASS_NO_ELICIT=1` turns this off.
- `add --label <text>`: a nickname shown when choosing. `request` / `hallpass_request_credential` accept a `label` (prefilled in the form, editable by the person), and with no `--name` pick the next free name (`play-google-com-2`), so a second account for a site no longer collides.
- Results include `account` (what to pass as `--as` to return to the same login) and, for a brand-new label, `new_account: true`. `hallpass sessions` shows `host` and `account` for saved logins.

- **Visible-window mode.** `--visible` (MCP `mode: "visible"`) shows the Chrome window so the user can watch, and still types a stored credential; `--headed` keeps its meaning (visible, the person signs in). `HALLPASS_WINDOW=visible|headless`, set by the person in the client's env, fixes the mode for every open and cannot be overridden by an agent. Switching an open account between modes was verified to relaunch the browser correctly.
- **`--new` to add an account.** A mistyped or invented `--as` is now `no_such_account` (listing the real ones) instead of silently starting a new empty saved login and opening a login window. `--as <label> --new` (MCP `new: true`) is how a second account is added.
- Expired credentials are flagged in `accounts`; a headless login wall no longer tells the agent to `resume` a window that was never opened.

Upgrading from 1.5.x (no data conversion)
- Stored credentials, saved sessions (`profiles/site-<host>`), state files and the audit log are read exactly as before; a credential saved by an older release simply has no nickname. A site with one login behaves as it always did.
- The saved login you made before this release stays the site's `default` login. Once a second account exists it is offered as "earlier saved login, no name yet", and **`hallpass name-login <url> <name>`** (MCP `hallpass_name_login`) names it in place, keeping the session. A credential an older release already called `default` keeps working and stays replaceable; importing an old export that contains a now-reserved name skips that entry instead of aborting the import.
- `hallpass doctor` now flags instruction files written by an older `hallpass install` that do not know about several accounts, and prints the command to refresh them.

Changed
- The name `default` is reserved for new credentials (like `site-*`).
- Tests: `test/accounts.test.mjs` (keys, listing, ambiguity, labels, reserved names, request) and `test/accounts-e2e.test.mjs` (two real Chrome profiles on one host stay separate; MCP elicitation picker, decline and forged answers).

## 1.5.1 (fix: opening any site with a dot in its host)

Fixed
- **`hallpass open https://example.com` failed on agent-browser 0.41.x** with `Invalid session name 'hp-site-example.com'`: 0.41 only accepts letters, digits, `-` and `_` in a session name, and hallpass named sessions after the host. Dots are now mapped to `_` when talking to agent-browser (the name the agent sees is unchanged). Found by installing 1.5.0 from the registry into a clean folder; the test suites only used `localhost`, which has no dot. A regression test now covers it. **1.5.0 is affected: upgrade.**

## 1.5.0 (activate, temp-folder uploads, click retry)

Changed
- The tested agent-browser line moves from 0.39.x to **0.41.x** (`~0.41.1`).
- Test fix: the setup tests imported a bare `C:/...` path, which Node rejects on Windows; they now use a `file://` URL.

Added
- **`activate <target> [Enter|Space]`**: focus a control and press a key, for pages where a pointer click returns success but does nothing (Play Console's sticky Save bar, dialog and wizard buttons). Gated like `click`; MCP guard and skill updated.
- **Uploads from the OS temp folder.** On Windows (and macOS) the fence around `%LOCALAPPDATA%` / `~/Library` also blocked the temp folder, so files an agent staged there (a scratch directory, a generated screenshot) were refused as "protected". The temp folder alone is now allowed; the rest of AppData / Library, the hallpass home and dot-folders stay fenced. Per-upload approval and the file-type and private-key checks are unchanged.
- A click, double click, check or uncheck that fails with "is covered by ..." now scrolls the target into view and retries once.

## 1.4.0 (end-to-end workflow audit: "publish my app to Play Console")

Fixed
- **An old pin kept an old agent-browser forever.** Users who had pinned a global agent-browser (0.27, the version that breaks on current Chrome) kept it after upgrading, and `doctor` called it fine. Hallpass's own copy now replaces an automatic pin (a pin the person made with `doctor --repin` is respected and flagged), `setup` installs 0.39.x for plugin installs that have no bundled copy, `doctor` flags older lines, and a binary without its execute bit is repaired.
- A failed first-run install (offline, proxy, disk) is reported to the agent as `not_installed` with the reason, instead of `setting_up` forever.
- **The action gate failed open on newer agent-browser releases**, and whenever a click target's label could not be read: a verbose lookup result pushed the real label ("Delete account") past a length cap, so the click was waved through. Labels are now read from the result's `text`/`value` field, and an unreadable target is treated as risky (the person is asked).
- **Fresh installs got a Chrome that agent-browser 0.27 cannot drive in a visible window** (Chrome 156 opens an extra New Tab and 0.27 attaches to that, so the login hand-off saw a blank page). The tested line moves to agent-browser 0.39.2, which handles it.
- **File uploads were impossible.** The `browser` tool and `hallpass do` blocked `upload`, so an agent could open Play Console and fill forms but never attach an `.aab` or store screenshots. `upload <selector> <files...>` now works (including hidden file inputs), with strict file vetting and a per-batch native approval (`HALLPASS_UPLOAD=ask|allow|off`).
- Text to type could be refused or mangled: release notes or descriptions beginning with `--`, or with a prefix such as `Data:` / `file:`, were rejected by the command guard, and a lone `--json` / `--headed` would have been eaten by the CLI's flag parser. Typed text is now exempt from the flag/URL checks and travels over stdin when it starts with `-`.
- The action gate missed "Send 7 changes for review" (Play Console's real label); and it interrupted routine, reversible clicks such as "Create new release". Both corrected.

Added
- **Zero-prerequisite install.** agent-browser is now a dependency (`~0.39.2`) and Chrome is fetched by an npm postinstall; if either is missing at run time (plugin installs never run npm) hallpass installs it itself: synchronously with progress in a terminal, in the background for the MCP server (`hallpass_open` answers `setting_up` meanwhile). `hallpass setup` runs it by hand, `hallpass doctor` checks Chrome, `HALLPASS_NO_AUTO_INSTALL=1` disables it. agent-browser is resolved from our own dependency / `~/.hallpass/runtime` before PATH, and musl Linux builds are found.
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
