<div align="center">

# 🛂 Hallpass Browser

**Let your AI agent log in to anything, without ever being able to read your password.**

[![npm](https://img.shields.io/npm/v/hallpass-browser?color=cb3837&logo=npm)](https://www.npmjs.com/package/hallpass-browser)
[![CI](https://github.com/techgniouss/hallpass-browser/actions/workflows/ci.yml/badge.svg)](https://github.com/techgniouss/hallpass-browser/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/node/v/hallpass-browser?logo=node.js&logoColor=white)](package.json)
[![MCP](https://img.shields.io/badge/MCP-server-8A2BE2)](#per-tool-setup)

Works with **Claude Code · Codex · Gemini CLI · Antigravity · Cursor · Windsurf · VS Code/Copilot**, or any agent that has a shell or speaks MCP.

</div>

---

## The problem

You want an agent to "go to my Play Console and publish the release", "check the Supabase dashboard", "download last month's invoices". Today you have two bad options:

1. **Paste your password into the chat.** It is now in a transcript, a log, and a model's context.
2. **Do the login yourself and hope the agent reuses it.** It works until the session expires, and then you are the bottleneck again.

Hallpass is the third option: the agent gets a **logged-in browser**, and **never sees the secret** that got it there.

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

## What it looks like

```console
# output abbreviated
$ hallpass open https://play.google.com/console
{"status":"needs_human","reason":"login","name":"play-console", ...}

# you log in (2-step prompt, passkey, CAPTCHA, whatever) in that window, then tell the agent

$ hallpass resume play-console
{"status":"logged_in","session":"hp-play-console","via":"human"}

# from now on the agent drives the logged-in page; later runs are headless and instant
$ hallpass do hp-play-console snapshot
```

No credential was ever given to the agent. The browser profile keeps the session, so next time `hallpass open` is usually silent.

## Why Hallpass

| | |
|---|---|
| 🔒 **Sealed vault** | Logins are AES-GCM encrypted with a key sealed by your OS (DPAPI / Keychain / libsecret). The agent can *use* a login; it cannot *read* one. |
| 🎯 **Origin pinning** | A password is only ever typed into the exact origin you approved. A look-alike page gets nothing. |
| 🙋 **Human hand-off** | CAPTCHA, push-approval MFA, passkeys and first logins open a **visible window for you**. Hallpass never fights a CAPTCHA and never types for you. |
| 🔑 **Automatic TOTP** | Authenticator codes are generated on the fly, never shown. |
| 🛑 **Irreversible-action gate** | Delete / Publish / Pay / Submit-type clicks need a native confirmation from you, not the model. |
| 🧾 **Tamper-evident audit log** | Hash-chained record of what agents did. No secrets in it. `hallpass log --verify` |
| 🧹 **Output redaction** | Secrets are scrubbed from what flows back to the model; password fields refuse to be read. |
| 🔌 **Works everywhere** | A CLI that prints JSON, an MCP server, and native plugins for Claude Code, Codex and Gemini CLI. |

Built on top of [agent-browser](https://github.com/vercel-labs/agent-browser), which drives Chrome.

> **Status: beta.** Read [SECURITY.md](SECURITY.md) (threat model, what is and is not protected) before trusting it with anything important. It has not been independently audited.

## Quick start (about two minutes)

Requirements: **Node 20+**. Nothing else: agent-browser is a dependency and Chrome (about 150 MB, once) is fetched automatically.

```bash
npm i -g hallpass-browser      # gives you the `hallpass` command
hallpass doctor                # checks Node, agent-browser, keystore
hallpass init --yes            # detects your AI tools and installs the instructions
```

Then ask your agent: *"Open my Supabase dashboard and tell me which projects are paused."* It will run `hallpass open`, hand you a window if a login is needed, and carry on.

Just want to try the MCP server without installing? `npx -y hallpass-browser mcp`.

<details>
<summary><b>Install details, plugin installs, and troubleshooting</b></summary>

Plugin installs (Claude Code, Codex, Gemini) never run `npm`, so the first `hallpass_open` answers `setting_up` while it installs agent-browser and Chrome in the background, and works a minute later. `hallpass setup` does it by hand; `HALLPASS_NO_AUTO_INSTALL=1` turns all of it off. On a bare Linux box Chrome may need system libraries: `agent-browser install --with-deps` (Hallpass never runs apt for you).

From a clone instead: `npm link` in the repository folder.

</details>

### Per-tool setup

Each tool gets a *native* package where one exists. **"Checked"** says how far it has been verified.

| Tool | Install | What you get | Checked |
|---|---|---|---|
| **Claude Code** | `/plugin marketplace add techgniouss/hallpass-browser` then `/plugin install hallpass-browser@hallpass-browser` | skill + MCP server, bundled | manifests pass `claude plugin validate`; MCP server and skill tested |
| **OpenAI Codex** | `npm i -g hallpass-browser`, then `codex plugin marketplace add techgniouss/hallpass-browser` | skill + MCP server (`.codex-plugin/`, `.agents/plugins/marketplace.json`) | **written from the official docs; no Codex CLI was available to run it** |
| **Gemini CLI** | `gemini extensions install https://github.com/techgniouss/hallpass-browser` | skill + MCP server + context (`gemini-extension.json`) | **written from the official docs; not run.** Google says Antigravity CLI is replacing Gemini CLI for some users |
| **Google Antigravity** (IDE and CLI) | `hallpass install --for antigravity` and `hallpass mcp-config --for antigravity` | a real skill in `~/.gemini/config/skills/` and an MCP entry for `~/.gemini/config/mcp_config.json` | file locations and formats confirmed against a working Antigravity IDE install; the agent itself not run |
| **Cursor / Windsurf / VS Code + Copilot** | `hallpass install --for cursor` (etc.) and `hallpass mcp-config --for <tool>` | rule file + MCP entry | rule/config formats from docs; tools not run |
| **Anything else with a shell** | nothing extra: it is a CLI that prints JSON | | tested |
| **ChatGPT / claude.ai (web)** | not supported | they only reach *remote* connectors, and exposing a local browser controller to the internet is something Hallpass deliberately does not do | |

`hallpass install --for <claude|codex|gemini|antigravity|antigravity-project|cursor|windsurf|copilot|agents|all>` writes the instruction files (only inside a marked block or a file Hallpass owns). `hallpass mcp-config --for <tool> [--npx]` **prints** the MCP configuration for a client; it never edits your config files.

## Use it

```bash
hallpass open https://play.google.com/console      # the agent runs this; deep links are fine
```

| Situation | What happens |
|---|---|
| You logged in before (or the page needs no login) | opens headless on that site's saved profile; no credentials involved |
| Login wall, no stored credential | a visible Chrome window opens; **you** log in (MFA, CAPTCHA, passkey, anything); tell the agent; it runs `hallpass resume`. Hallpass never types for you. The profile keeps the session. |
| A stored credential matches the site | logs in headless, typing the password without ever showing it (TOTP included) |

Flags: `--headed` (you always log in), `--headless` (never open a window), `--as <name>` (pick the account when several match; Hallpass refuses to guess).

### Add a credential (optional, for hands-free logins)

- **Let the agent ask, you type:** the agent runs `hallpass request <login-url>` (MCP: `hallpass_request_credential`). A one-time form opens in *your* browser; you type the login; the agent never sees it.
- **Or in your own terminal:** `hallpass add supabase --url https://supabase.com/dashboard/sign-in --origin "https://*.supabase.com" --success-url "https://supabase.com/dashboard/**"`
- **From a password manager:** `--password-ref op://Vault/Item/password` (also `bw:<id>`, `pass:<path>`): Hallpass stores a pointer and fetches the secret at login.

## How it compares

| Approach | Agent sees the password? | Survives session expiry? | Handles CAPTCHA / MFA? | Stops "delete account" clicks? |
|---|---|---|---|---|
| Paste the password into the prompt | **Yes** | yes | no | no |
| Export cookies / reuse your own browser profile | No, but it holds a full session | until it expires | no | no |
| Headless script with env-var credentials | Yes (in the process the agent controls) | yes | no | no |
| **Hallpass** | **No** | yes (vault) or by profile | **Hands off to you** | **Yes, native confirmation** |

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

## FAQ

**Can the agent just read the password out of the page?** No. Typed values are cleared after entry, and the MCP tool refuses to read password fields. A shell agent can still call `agent-browser` directly, which is why the vault, not the browser, is the trust boundary. See [SECURITY.md](SECURITY.md).

**Does it solve CAPTCHAs?** No, on purpose. It hands them to you in a visible window.

**Does it send my data anywhere?** No. The vault, profiles and audit log live on your machine. Cloud browsers are opt-in.

**Do I have to store credentials?** No. The default is that *you* log in once in a visible window and the profile keeps the session.

**Which sites work?** Anything agent-browser can open. Sign-in detection is heuristic (it ships a 28-page corpus in 7 languages), so when it guesses wrong it asks you instead of failing.

## Development and tests

```bash
git clone https://github.com/techgniouss/hallpass-browser && cd hallpass-browser
npm install
npm test              # no browser: crypto/vault, TOTP (RFC 6238), origins, redaction, policy, audit chain, references, credential form, export/import, trust, packaging
npm run test:browser  # real Chrome: logins, hand-offs, MCP server, action gate, 28-page detection corpus (opens a visible window or two)
npm run test:dialog   # Windows: the real native approval dialog, answered by clicks and keypresses
npm run test:all
```

Everything runs against local mock sites. The detection corpus is structural re-creations of common sign-in pages, not copies of real sites, so it measures regressions, not real-world accuracy. CI runs the unit and browser suites on Linux, Windows and macOS.

## Known limits

- **Windows** is the most exercised platform. macOS and Linux pass CI, but CI uses the file keystore there; the real Keychain (macOS) and libsecret (Linux) paths and the zenity/osascript dialogs have not been run by hand.
- **agent-browser compatibility:** tested against 0.41.x (0.27.x also needs a Chrome older than about 155: its headed window loses the page on newer Chrome). Other releases may change output formats; `hallpass doctor` tells you which version you have.
- Logins inside **iframes or shadow DOM** are not auto-filled (the page still reads as a login wall, so a person is asked). Sites needing extra fields (e.g. AWS IAM account ID) need a site recipe (not built, see [ROADMAP](ROADMAP.md)).
- **Passkeys/WebAuthn** can be used by *you* in the hand-off window, but Hallpass cannot store or replay them. Reading **email/SMS codes** and a **separate-user broker** are not built.
- The **action gate** is a heuristic on labels: it catches common dangerous buttons, not every one, and a shell agent can bypass it by calling `agent-browser` directly.
- Vaults are bound to one OS account; move machines with `export` / `import`.

## Contributing

Issues and pull requests are welcome, especially: **macOS and Linux testing**, **site recipes**, and **more sign-in detection fixtures**. Start with [CONTRIBUTING.md](CONTRIBUTING.md) and the [ROADMAP](ROADMAP.md); look for issues labelled `good first issue`. Please report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

If Hallpass saves you from pasting a password into a chat, a ⭐ helps other people find it.

[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) · [CHANGELOG.md](CHANGELOG.md) · MIT licensed ([LICENSE](LICENSE)).

Use it only on accounts you own and where automation is permitted by the site's terms. Hallpass does not solve CAPTCHAs or bypass bot protection: it hands them to you.
