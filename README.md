# Hallpass Browser

**Let an AI agent log in to anything without ever being able to read your password.**

Hallpass wraps [agent-browser](https://github.com/vercel-labs/agent-browser) with a sealed credential vault, origin pinning, automatic TOTP, output redaction, per-use approval, an irreversible-action gate, and a clean hand-off to *you* (a visible browser window) for CAPTCHAs, push-approval MFA, and first logins. It works with Claude Code, Codex, Gemini CLI, Antigravity, Cursor, Windsurf, VS Code/Copilot, or any agent that has a shell or speaks MCP.

> **Status: beta.** Built and tested on Windows. macOS and Linux code paths exist but have not been run. Not independently security-audited. Read [SECURITY.md](SECURITY.md) before trusting it with anything important.

```
 you (own terminal / private form)       agent (any AI tool)
 ─────────────────────────────────       ───────────────────────────────
 hallpass add / request  ──▶ vault       hallpass open https://…
   (typed by you, hidden)  (AES-GCM,       ├─ unseals in-process, never prints
                            OS-sealed key) ├─ checks the page origin is approved
                                           ├─ types via stdin into tagged fields
      ◀── CAPTCHA / MFA / login ────────   ├─ TOTP generated on the fly
   you act in the visible window           └─ {"status":"logged_in","session":"hp-…"}
        hallpass resume ───────────▶ agent drives the logged-in page
```

## Install

Requirements: **Node 20+**. Nothing else to install: [agent-browser](https://www.npmjs.com/package/agent-browser) (the program that drives Chrome) is a dependency of this package, and Chrome for it is downloaded automatically (about 150 MB, once) by `npm i`, or on first use if that step was skipped. This also covers plugin installs (Claude Code, Codex, Gemini), where `npm` never runs: the first `hallpass_open` answers `setting_up` while it installs in the background, and works a minute later. `hallpass setup` does it by hand; `HALLPASS_NO_AUTO_INSTALL=1` turns it all off. On a bare Linux box Chrome may need system libraries: `agent-browser install --with-deps` (hallpass never runs apt for you).

```bash
npm i -g hallpass-browser      # gives you the `hallpass` command
hallpass doctor                # checks Node, agent-browser, keystore
hallpass init --yes            # detects your AI tools and installs the instructions
```

(From a clone instead: `npm link` in this folder.)

### Per-tool setup

Each tool gets a *native* package where one exists. **"Checked"** says how far I have verified it, honestly.

| Tool | Install | What you get | Checked |
|---|---|---|---|
| **Claude Code** | `/plugin marketplace add techgniouss/hallpass-browser` then `/plugin install hallpass-browser@hallpass-browser` | skill + MCP server, bundled | manifests pass `claude plugin validate`; MCP server and skill tested |
| **OpenAI Codex** | `npm i -g hallpass-browser`, then `codex plugin marketplace add techgniouss/hallpass-browser` | skill + MCP server (`.codex-plugin/`, `.agents/plugins/marketplace.json`) | **written from the official docs; no Codex CLI was available to run it** |
| **Gemini CLI** | `gemini extensions install https://github.com/techgniouss/hallpass-browser` | skill + MCP server + context (`gemini-extension.json`) | **written from the official docs; not run.** Google says Antigravity CLI is replacing Gemini CLI for some users |
| **Google Antigravity** (IDE and CLI) | `hallpass install --for antigravity` and `hallpass mcp-config --for antigravity` | a real skill in `~/.gemini/config/skills/` and an MCP entry for `~/.gemini/config/mcp_config.json` | file locations and formats confirmed against a working Antigravity IDE install; the agent itself not run |
| **Cursor / Windsurf / VS Code + Copilot** | `hallpass install --for cursor` (etc.) and `hallpass mcp-config --for <tool>` | rule file + MCP entry | rule/config formats from docs; tools not run |
| **Anything else with a shell** | nothing extra: it is a CLI that prints JSON | | tested |
| **ChatGPT / claude.ai (web)** | not supported | they only reach *remote* connectors, and exposing a local browser controller to the internet is something Hallpass deliberately does not do | |

`hallpass install --for <claude|codex|gemini|antigravity|antigravity-project|cursor|windsurf|copilot|agents|all>` writes the instruction files (only inside a marked block or a file Hallpass owns). `hallpass mcp-config --for <tool> [--npx]` **prints** the MCP configuration for a client; it never edits your config files. `--npx` prints the `npx -y hallpass-browser mcp` form for people who installed from npm.

## Use it

```bash
hallpass open https://play.google.com/console      # the agent runs this; deep links are fine
```

| Situation | What happens |
|---|---|
| You logged in before (or the page needs no login) | opens headless on that site's saved profile; no credentials involved |
| Login wall, no stored credential | a visible Chrome window opens; **you** log in (MFA, CAPTCHA, anything); tell the agent; it runs `hallpass resume`. Hallpass never types for you. The profile keeps the session. |
| A stored credential matches the site | logs in headless, typing the password without ever showing it (TOTP included) |

Flags: `--headed` (you always log in), `--headless` (never open a window), `--as <name>` (pick the account when several match; Hallpass refuses to guess).

### Add a credential (optional)

- **Let the agent ask, you type:** the agent runs `hallpass request <login-url>` (MCP: `hallpass_request_credential`). A one-time form opens in *your* browser; you type the login; the agent never sees it.
- **Or in your own terminal:** `hallpass add supabase --url https://supabase.com/dashboard/sign-in --origin "https://*.supabase.com" --success-url "https://supabase.com/dashboard/**"`
- **From a password manager:** `--password-ref op://Vault/Item/password` (also `bw:<id>`, `pass:<path>`): Hallpass stores a pointer and fetches the secret at login.

## Safety controls

| Control | What it does | How to turn it on |
|---|---|---|
| Per-use approval | Native dialog (Allow once / 1 hour / Deny), focus defaults to Deny; no desktop = deny | `add --require-approval` (or tick it in the request form) |
| Credential limits | Expiry and sign-in count | `--expires 30d`, `--max-uses 5` |
| Lockout protection | After a rejected password, automatic login stops until a person fixes it | always on; `hallpass unlock <name>` / `add --force` |
| Action gate | Delete / Publish / Pay / Submit-type clicks need a native confirmation | default for the MCP `browser` tool and `hallpass do`; `HALLPASS_GATE=off\|risky\|all` |
| Read-only server | Observation only | `HALLPASS_READONLY=1` in the MCP client config |
| Audit log | Hash-chained record of what agents did; no secrets | `hallpass log`, `hallpass log --verify` |
| Password readback guard | Typed secrets are cleared after typing; the MCP tool refuses to read password fields | always on |
| Backup / move machines | Passphrase-encrypted export/import | `hallpass export file` / `import file` (terminal only) |

| An agent can | Only a person (real terminal / native dialog) can |
|---|---|
| `open`, `resume`, `login`, `status`, `logout`, `sessions`, `prune`, `log` | `add --force` (replace), `remove`, `unlock`, `export`, `import`, `doctor --repin` |
| `request` a new login (a person types it into a form), `add` a brand-new one via stdin | register a password-manager reference, approve a sign-in, confirm a risky click |
| use a stored login (typed for it; never shown) | read a password back |

Housekeeping: `hallpass sessions`, `hallpass prune --older-than 30d`, `hallpass init`, `hallpass doctor`. Containers/CI without an OS keyring can opt in to `HALLPASS_KEYSTORE=file` (weaker: protects only against other OS users). Cloud browsers work through agent-browser's own `AGENT_BROWSER_PROVIDER` setting; credentials are still resolved locally.

## Tests

```bash
npm test              # no browser: crypto/vault, TOTP (RFC 6238), origins, redaction, policy, audit chain, references, credential form, export/import, trust, packaging
npm run test:browser  # real Chrome: logins, hand-offs, MCP server, action gate, 28-page detection corpus (opens a visible window or two)
npm run test:dialog   # Windows: the real native approval dialog, answered by clicks and keypresses
npm run test:all
```

Everything runs against local mock sites. The detection corpus is structural re-creations of common sign-in pages, not copies of real sites, so it measures regressions, not real-world accuracy.

## Known limits

- Only **Windows** has been exercised. macOS (Keychain, osascript) and Linux (libsecret, zenity) paths exist but are unrun; `.github/workflows/ci.yml` is written to cover them and has never been run.
- **agent-browser compatibility:** tested against 0.39.x (0.27.x also needs a Chrome older than about 155: its headed window loses the page on newer Chrome). Other releases may change output formats; `hallpass doctor` tells you which version you have.
- Logins inside **iframes or shadow DOM** are not auto-filled (the page still reads as a login wall, so a person is asked). Sites needing extra fields (e.g. AWS IAM account ID) need a site recipe (not built, see [ROADMAP](ROADMAP.md)).
- **Passkeys/WebAuthn**, reading **email/SMS codes**, and a **separate-user broker** are not built.
- The **action gate** is a heuristic on labels: it catches common dangerous buttons, not every one, and a shell agent can bypass it by calling `agent-browser` directly.
- Vaults are bound to one OS account; move machines with `export` / `import`.

## Contributing, security, license

[CONTRIBUTING.md](CONTRIBUTING.md) · [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) · [SECURITY.md](SECURITY.md) (how to report a vulnerability) · [CHANGELOG.md](CHANGELOG.md) · [ROADMAP.md](ROADMAP.md) · MIT licensed ([LICENSE](LICENSE)).

Use it only on accounts you own and where automation is permitted by the site's terms. Hallpass does not solve CAPTCHAs or bypass bot protection: it hands them to you.
