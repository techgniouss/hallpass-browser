# hallpass

Let an AI agent **log in to anything without ever being able to read your password.**

hallpass wraps [agent-browser](https://www.npmjs.com/package/agent-browser) with a sealed credential vault, origin pinning, automatic TOTP, output redaction, and a clean hand-off to you (visible browser window) for CAPTCHAs and push-approval MFA. It ships as a CLI plus an agent skill, so Claude can do "log into Supabase and ...", "open Play Console and ..." end to end.

```
 you (own terminal)                      agent (Claude)
 ──────────────────                      ───────────────────────────────
 hallpass add supabase ...   ──▶ vault    hallpass login supabase
   (password typed hidden)   (AES-GCM,     ├─ unseals in-process, never prints
                              DPAPI key)   ├─ checks page origin is approved
                                           ├─ types via stdin into tagged fields
        ◀── CAPTCHA / MFA ───────────────  ├─ TOTP generated on the fly
   you act in the visible window           └─ {"status":"logged_in","session":"hp-supabase"}
        hallpass resume supabase ──────▶ agent-browser --session hp-supabase snapshot -i ...
```

## Install

Requires Node 20+ and `agent-browser` (`npm i -g agent-browser && agent-browser install`).

```bash
cd hallpass
npm link                 # puts `hallpass` on PATH
hallpass doctor           # checks node, agent-browser, keystore
hallpass install-skill    # copies the skill to ~/.claude/skills/hallpass
```

## Two ways in, for any site

```bash
hallpass open https://play.google.com/console     # the agent runs this; the URL can be a deep link
```

| Situation | What happens |
|---|---|
| **You logged in before** (or the page needs no login) | opens headless on that site's saved profile, no credentials involved |
| **Login wall, no stored credential** | a visible Chrome window opens on it; **you** log in (MFA, CAPTCHA, anything); tell the agent; it runs `hallpass resume` and carries on. hallpass never types for you. The profile keeps the session, so next time is headless. |
| **A stored credential matches the site** | logs in headless, typing the password without ever showing it (TOTP included) |

`--headed` forces "you log in", `--headless` never opens a window, `--as <name>` chooses the account when more than one is stored (hallpass refuses to guess).

You don't have to set anything up first. Stored credentials are an optional upgrade for hands-free repeat logins:

## Works with any AI tool

hallpass is a plain CLI that prints JSON, so any agent with a shell can use it. For richer integration there are two layers, and you can use both:

**1. Instructions: teach the tool the rules and workflow**
```bash
hallpass install --for claude        # Claude Code skill
hallpass install --for codex         # OpenAI Codex CLI / IDE  (~/.codex/AGENTS.md)
hallpass install --for gemini        # Gemini CLI              (~/.gemini/GEMINI.md)
hallpass install --for antigravity   # Google Antigravity      (~/.gemini/GEMINI.md)
hallpass install --for cursor        # Cursor rule             (.cursor/rules/hallpass.mdc, in the current project)
hallpass install --for windsurf      # Windsurf rule           (.windsurf/rules/)
hallpass install --for copilot       # GitHub Copilot          (.github/copilot-instructions.md)
hallpass install --for agents        # anything that reads AGENTS.md
hallpass install --for all
```
Files are edited only inside a marked `hallpass:begin/end` block (or a file hallpass owns), so re-running is safe and your own content is never touched.

**2. MCP server: native tools inside the IDE, no shell required**
```bash
hallpass mcp-config --for cursor     # prints the exact config + where it goes (also: claude gemini antigravity windsurf vscode codex)
```
The client then gets `hallpass_open`, `hallpass_resume`, `hallpass_status`, `hallpass_logout`, `hallpass_list`, plus `browser` and `browser_screenshot` to drive the logged-in page. There is deliberately **no** tool that adds, reads or exports a credential. The `browser` tool is restricted: hallpass sessions only (`hp-*`), a fixed list of page commands, no `eval`/cookies/storage/upload/download/network, no `file:` or `javascript:` URLs, and page text comes back inside content-boundary markers.

| Tool | Shell CLI | MCP | Notes |
|---|---|---|---|
| Claude Code / Desktop | yes | yes | skill + MCP |
| OpenAI Codex CLI / IDE extension | yes | yes | |
| Gemini CLI | yes | yes | |
| Google Antigravity | yes | yes | instruction/MCP file locations vary by version; the printed config tells you what to paste |
| Cursor, Windsurf, VS Code + Copilot | yes | yes | |
| ChatGPT web/desktop, claude.ai | no | no | these only reach *remote* HTTPS connectors, not a local program. Exposing a local browser controller to the internet is not something hallpass does. Use Codex or another local agent. |

## Add a credential (optional)

**Easiest: let the agent ask, you type.** When a site needs a login, the agent runs `hallpass request <login-url>` (or the MCP tool `hallpass_request_credential`). A one-time form opens in *your* browser; you type the login there; the agent never sees it.

**Or in your own terminal:**

```bash
hallpass add supabase --url https://supabase.com/dashboard/sign-in \
  --origin "https://*.supabase.com" --success-url "https://supabase.com/dashboard/**"
# Username / email: you@example.com
# Password (hidden):
# TOTP secret or otpauth:// URI (hidden, Enter to skip):
```

The agent cannot do this step: `add` demands a real keyboard. To load from a password manager instead: `op read ... | hallpass add NAME --url ... --stdin-json`.

## Use it (the agent)

```bash
hallpass login supabase                       # -> {"status":"logged_in","session":"hp-supabase",...}
agent-browser --session hp-supabase snapshot -i
```

When a human is needed you get `{"status":"needs_human","reason":"captcha",...}` (exit code 10) and a visible Chrome window already sitting on the challenge. Solve it, then:

```bash
hallpass resume supabase
```

| Command | Purpose |
|---|---|
| `add / remove` | manage entries (human, TTY) |
| `list / show` | metadata only |
| `login [--headed\|--headless] [--manual] [--wait s]` | log in; idempotent; auto-escalates to a visible window |
| `resume` | continue after the human step |
| `status / logout [--wipe]` | inspect / close / forget the session |
| `doctor / harden / install-skill` | setup helpers |

## Examples

**Google Play Console, production access**
```bash
hallpass add playconsole --url https://play.google.com/console \
  --origin https://accounts.google.com --origin https://play.google.com \
  --success-url "https://play.google.com/console/**"
```
The first Google login on a new profile usually asks for a device approval: Claude reports `needs_human`, you approve in the window, `hallpass resume`. After that the profile holds the session. Claude fills the form but, per the skill, stops before pressing the final *Apply / Submit* and asks you.

**Anything with a non-standard form**: add `--username-selector`, `--password-selector`, `--submit-selector`, or do the first login with `hallpass login NAME --manual`.

## Safety controls at a glance

| Control | What it does | How to turn it on |
|---|---|---|
| Per-use approval | Native dialog (Allow once / 1 hour / Deny) before a stored login is used; no desktop = deny | `hallpass add ... --require-approval` (or tick it in the request form) |
| Credential limits | Expiry and sign-in count | `--expires 30d`, `--max-uses 5` |
| Lockout protection | After a rejected password, automatic login stops until a person fixes it | always on; `hallpass unlock <name>` / `add --force` |
| Action gate | Delete / Publish / Pay / Submit-type clicks need a native confirmation | on by default for the MCP `browser` tool and `hallpass do`; `HALLPASS_GATE=off\|risky\|all` |
| Read-only server | Observation only, no clicks/typing | set `HALLPASS_READONLY=1` in the MCP client config |
| Audit log | Tamper-evident record of what the agent did, no secrets | `hallpass log`, `hallpass log --verify` |
| Password-manager refs | Store a pointer, not the password | `--password-ref op://...`, `bw:<id>`, `pass:<path>` |
| Backup / move machines | Passphrase-encrypted export and import | `hallpass export file` / `import file` (terminal only) |

Housekeeping: `hallpass sessions`, `hallpass prune --older-than 30d`, `hallpass init`, `hallpass doctor`. Containers and CI without an OS keyring can opt in to a file keystore with `HALLPASS_KEYSTORE=file` (weaker: protects only against other OS users).

Cloud browsers (Browserbase, Kernel, ...) work through agent-browser's own `AGENT_BROWSER_PROVIDER` setting, which hallpass passes through; credentials are still resolved locally.

## Tests

```bash
npm test              # no browser: crypto/vault, TOTP (RFC 6238), origins, redaction, policy, audit chain, references, credential form, export/import
npm run test:browser  # real Chrome: logins, hand-offs, MCP server, action gate, 28-page detection corpus (opens a visible window or two)
npm run test:dialog   # Windows: the real native approval dialog, answered by a click (pops a dialog on screen)
npm run test:all
```
Everything runs against local mock sites. The detection corpus is made of structural re-creations of common sign-in pages, not copies of real sites, so it measures regressions, not real-world accuracy.

## What an agent can and cannot do (summary)

| An agent can | Only a person (real terminal / native dialog) can |
|---|---|
| `open`, `resume`, `login`, `status`, `logout`, `sessions`, `prune`, `log` | `add --force` (replace), `remove`, `unlock`, `export`, `import`, `doctor --repin` |
| `request` a new login (a person types it into a form) and `add` a brand-new one via stdin | register a password-manager reference, approve a sign-in, confirm a risky click |
| use a stored login (typed for it; never shown) | read a password back (blocked on password fields; fields are cleared after typing) |

## Known limits

- Only **Windows** has been exercised by the test suite. macOS (Keychain, osascript dialogs) and Linux (libsecret, zenity) code paths exist but are unrun; `.github/workflows/ci.yml` is written to cover them and has never been run.
- Logins inside **iframes or shadow DOM** are not auto-filled; the page still reads as a login wall, so a person is asked. Sites needing extra fields (e.g. AWS IAM account ID) need a site recipe (not built yet, see ROADMAP).
- **Passkeys/WebAuthn**, reading **email/SMS codes** automatically, and a **separate-user broker** are not built.
- The **action gate** is a heuristic on button labels: it catches common dangerous buttons, not every one, and shell agents can bypass it by calling `agent-browser` directly.
- Vaults are bound to one OS account; move machines with `export` / `import`.

## Read this

[SECURITY.md](SECURITY.md) is short and honest about what is and is not protected. In one line: hallpass stops the agent *reading* your password and stops it typing it into the wrong site; it does not stop a fully-privileged same-user process from calling OS crypto, and a logged-in session can do whatever the account can.
