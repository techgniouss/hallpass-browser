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
| 🛑 **Irreversible-action gate** | Delete / Publish / Pay / Submit-type clicks need a native confirmation from you, not the model. Turn the dialogs down per site (`trusted`) or everywhere (`full`) when you want less friction, from your own terminal only. |
| 👥 **Several accounts per site** | Two Google logins on Play Console, personal and work GitHub: each is separate, and the agent asks you which one instead of guessing. |
| 👀 **Watch mode** | `--visible` shows the browser while the agent works, and still signs in for you. |
| 🧾 **Tamper-evident audit log** | Hash-chained record of what agents did. No secrets in it. `hallpass log --verify` |
| 🧹 **Output redaction** | Secrets are scrubbed from what flows back to the model; password fields refuse to be read. |
| 🔌 **Works everywhere** | A CLI that prints JSON, an MCP server, and native plugins for Claude Code, Codex and Gemini CLI. |

> **Status: beta.** Read [SECURITY.md](SECURITY.md) (threat model, what is and is not protected) before trusting it with anything important. It has not been independently audited.

## Quick start (about two minutes)

Requirements: **Node 20+**. Nothing else: the browser tooling and Chrome (about 150 MB, once) are fetched automatically.

```bash
npm i -g hallpass-browser      # gives you the `hallpass` command
hallpass doctor                # checks Node, the browser tooling, keystore
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

### Quick reads of public pages (optional)

For tasks that only need to **read** a public page (docs, a changelog, a status page), `hallpass fetch <url>` (MCP: `hallpass_fetch`) can skip starting Chrome. It needs a one-time opt-in and is deliberately narrow:

- **Anonymous and read-only.** Never logged in, no cookies, nothing typed or clicked, `https://` only. Anything behind a login still goes through `hallpass open`.
- **No evasion.** `robots.txt` is always obeyed (`blocked_by_robots`), and a login wall or bot check comes back as `suspected_block` so the agent hands over to you instead of working around it.
- **You choose the engine.** It uses [Obscura](https://github.com/h4ckf0r0day/obscura), a young third-party project, so some pages render differently from Chrome. Download the plain (not `-stealth`) build from its releases, then in your own terminal: `hallpass obscura --pin <path-to-obscura>` (undo: `hallpass obscura --unpin`). Until then `hallpass fetch` says `unavailable` and nothing changes.

It mainly helps the first read of a task (no browser start-up) and keeps memory use low; once Chrome is already running it is no faster.

### Watching the browser (window mode)

Say *"do it in a visible window"* or *"let me watch"* and the agent uses `--visible`. You can switch an open account between modes at any time.

| Flag (MCP `mode`) | Window | Who signs in |
|---|---|---|
| *(none)* `auto` | headless; a visible window opens only when you must act (login wall, CAPTCHA, MFA) | stored login, or you |
| `--visible` | **visible all the way**, so you can watch the agent work | stored login is typed for you; you act only if asked |
| `--headed` | visible | **you** (nothing is typed, even if a login is stored) |
| `--headless` | never | stored login; a login wall is just reported |

To make it a rule for everything, set `HALLPASS_WINDOW=visible` (or `headless`) in your MCP client's environment. An agent cannot override it.

### Several accounts on one site

Play Console with two Google logins, GitHub personal and work, two Supabase organisations: each login is kept separate, and **Hallpass never guesses between them**.

| You want | Do this |
|---|---|
| See what exists for a site | `hallpass accounts https://play.google.com/console` (MCP: `hallpass_accounts`). Lists stored credentials (name, masked user, nickname, locked or expired?) and saved browser logins (label, last used). Never a secret. `hallpass accounts` alone lists every site. |
| Use a specific one | `hallpass open <url> --as <name>` (MCP: `as`). `<name>` is a stored credential's name, or the label of a saved browser login. |
| Add a second account **without storing a password** | `hallpass open <url> --as work --new`: starts a new, empty saved login; you sign in once in the window, and `--as work` is instant afterwards. `--new` is required so a mistyped name is an error, not a surprise new account. Accounts are separate browser profiles, so they never leak into each other. |
| Add a second **hands-free** account | `hallpass add play-alt --url <login-url> --label "Alt developer account"`, or let the agent run `hallpass request <login-url> --name play-alt` (without `--name`, a free name such as `play-google-com-2` is chosen and you can type a nickname in the form). |
| The login you already had | nothing to migrate: it keeps working, and it is `--as default`. While it is the only login for a site, `open` uses it exactly as before. Once the site has a second account, Hallpass lists it as an "earlier saved login with no name yet" and the agent asks you whose it is. Name it once with `hallpass name-login <url> <name>` (MCP: `hallpass_name_login`); your saved session moves with it, no sign-in needed. |

If a site has more than one login and the agent does not say which, `open` stops with `reason: "ambiguous_account"` and the list of choices, and the agent must **ask you**. In an MCP client that supports *elicitation* (a native picker), Hallpass shows you the choice directly. Any other agent (Claude Code, Codex, Gemini CLI, Cursor, ...) is told by its instructions to ask you in chat and then repeat the call with `--as <your choice>`. The same flow works from a plain shell.

**Upgrading from an earlier release:** stored credentials, saved sessions and the audit log are read as they are; there is no conversion step. After upgrading, run `hallpass doctor`: it tells you if the instruction files an earlier `hallpass install` wrote (Codex, Gemini, the Claude skill) need `hallpass install --for <tool>` again, so your agent knows how to ask which account. Plugin installs update on their own.

### How much it asks you (access levels)

By default Hallpass asks you before anything risky: a native dialog for Delete / Publish / Pay / Submit-type clicks, for file uploads, and for stored logins you marked "ask each time". That is the right default. The click dialog also offers **Allow for 1 hour** (one site, one session, in memory only), and a dialog that times out is reported to the agent as "not seen", not as a refusal. When you are doing a lot of trusted work, you can turn the dialogs down, **from your own terminal only** (an agent cannot):

| Level | What changes | Command |
|---|---|---|
| `ask` (default) | every confirmation applies | `hallpass access ask` |
| `trusted` | no click or upload dialogs **on the sites you list**; everything else still asks. This is the one most people want. | `hallpass access trusted play.google.com "*.supabase.com"` |
| `full` | no click or upload dialogs anywhere. Expires after **4 hours** unless you choose a time (`--for 8h`) or `--forever`. | `hallpass access full` |

Add `--include-credentials` to also skip the approval dialog of stored logins that ask each time (they keep asking otherwise: you chose that for that specific login). Under `trusted` this only applies to a login whose every approved origin (its login page and any SSO hop) is on your list; the page an agent asks to open does not count, because a trusted site can redirect anywhere. `hallpass access` shows what is on and when it ends; `hallpass doctor` flags it; results to the agent carry `"access": "trusted"` so nothing is hidden; every skipped dialog is recorded in `hallpass log`.

**Never switched off by any level:** secrets stay unreadable and redacted; a login is typed only on its pinned origin; `eval`, cookies, network and `file://` stay blocked; uploads still refuse private keys, config folders and unknown file types; adding, removing and exporting logins still needs you at a terminal; a rejected password still locks that login; expiry and use limits still apply; CAPTCHAs still come to you; `HALLPASS_READONLY=1` and `HALLPASS_UPLOAD=off` still restrict the agent.

The setting is signed with a key derived from your vault key, so editing the file by hand does nothing, and an expired or damaged one means "ask". Note what it does and does not give you: it removes the pop-ups, which are your main defence against a web page tricking the agent into clicking "Delete account". `trusted` limits that to sites you named; prefer it, and prefer a time limit. See [SECURITY.md](SECURITY.md).

### Add a credential (optional, for hands-free logins)

- **Let the agent ask, you type:** the agent runs `hallpass request <login-url>` (MCP: `hallpass_request_credential`). A one-time form opens in *your* browser; you type the login; the agent never sees it.
- **Or in your own terminal:** `hallpass add supabase --url https://supabase.com/dashboard/sign-in --origin "https://*.supabase.com" --success-url "https://supabase.com/dashboard/**"`
- **From a password manager:** `--password-ref op://Vault/Item/password` (also `bw:<id>`, `pass:<path>`): Hallpass stores a pointer and fetches the secret at login.

### Updates

Hallpass tells you when a newer version is published, and lets you decide.

- About once a day it quietly asks the npm registry for the latest version number (one anonymous request, see the FAQ for exactly what is sent). It never slows a command down: it runs in a background process.
- When a newer version exists, your agent's next `open` result includes `update_available`, and the agent tells you once and asks whether you want to update. `hallpass doctor` shows it too.
- **Updating is yours to do, from your own terminal:** `hallpass update` shows what is new and, for a global npm install, asks `Type yes to update now` before running `npm install -g hallpass-browser@latest`. For other installs it prints the right command (Claude Code plugin, Gemini extension, `npx`, a git clone). An agent can look (`hallpass update --check`, MCP `hallpass_version`) but cannot install anything.
- Restart your AI tool afterwards so it starts the new version. Turn the check off with `HALLPASS_NO_UPDATE_CHECK=1` (it is also off in CI).

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
| Per-use approval | Native dialog (Allow once / 1 hour / Deny), no button has keyboard focus so a stray key answers nothing; no desktop = not approved | `add --require-approval` (or tick it in the request form) |
| Credential limits | Expiry and sign-in count | `--expires 30d`, `--max-uses 5` |
| Lockout protection | After a rejected password, automatic login stops until a person fixes it | always on; `hallpass unlock <name>` / `add --force` |
| Action gate | Delete / Publish / Pay / Submit-type clicks need a native confirmation | default for the MCP `browser` tool and `hallpass do`; loosen it deliberately with [access levels](#how-much-it-asks-you-access-levels) |
| Upload approval | Each file upload is vetted (types, no keys or config folders) and confirmed | default; `HALLPASS_UPLOAD=off` disables uploads |
| Read-only server | Observation only | `HALLPASS_READONLY=1` in the MCP client config |
| Several accounts | Never guesses which login to use; saved logins are separate browser profiles | automatic; see [Several accounts](#several-accounts-on-one-site) |
| Audit log | Hash-chained record of what agents did, including every dialog an access level skipped; no secrets | `hallpass log`, `hallpass log --verify` |
| Password readback guard | Typed secrets are cleared after typing; the MCP tool refuses to read password fields | always on |
| Backup / move machines | Passphrase-encrypted export/import | `hallpass export file` / `import file` (terminal only) |

| An agent can | Only a person (real terminal / native dialog) can |
|---|---|
| `open`, `resume`, `login`, `status`, `logout`, `sessions`, `prune`, `log`, `accounts`, read `access` | `add --force` (replace), `remove`, `unlock`, `export`, `import`, `doctor --repin` |
| `request` a new login (a person types it into a form), `add` a brand-new one via stdin | register a password-manager reference, approve a sign-in, confirm a risky click |
| use a stored login (typed for it; never shown), name an unnamed saved login the user told it to | read a password back, **loosen the access level** (`access trusted` / `full`) |
| turn dialogs back on (`hallpass access ask`) | |

Housekeeping: `hallpass sessions`, `hallpass prune --older-than 30d`, `hallpass init`, `hallpass doctor`. Containers/CI without an OS keyring can opt in to `HALLPASS_KEYSTORE=file` (weaker: protects only against other OS users). Cloud browsers work through agent-browser's own `AGENT_BROWSER_PROVIDER` setting; credentials are still resolved locally.

### Settings reference

| Setting | Where | Meaning |
|---|---|---|
| `hallpass access ask \| trusted <site>... \| full` | your terminal | how many confirmation dialogs you want (see above) |
| `HALLPASS_WINDOW=visible\|headless` | MCP client env | fix the window mode for every open; the agent cannot override it |
| `HALLPASS_READONLY=1` | MCP client env | the agent can look but not change anything |
| `HALLPASS_UPLOAD=ask\|allow\|off` | MCP client env | upload dialogs; `off` disables uploads (`allow` is older than access levels: prefer `hallpass access trusted`) |
| `HALLPASS_GATE=risky\|all\|off` | MCP client env | which clicks count as risky (`off` is older than access levels: prefer `hallpass access`) |
| `HALLPASS_NO_UI=1` | env | no dialogs at all: every confirmation is denied (CI, servers) |
| `HALLPASS_NO_ELICIT=1` | env | never show the account picker; the agent asks in chat instead |
| `HALLPASS_NO_UPDATE_CHECK=1` | env | no daily check for a newer version (also off in CI) |
| `HALLPASS_HOME`, `HALLPASS_KEYSTORE=file`, `HALLPASS_NO_AUTO_INSTALL=1` | env | data folder, file keystore, no automatic browser install |

> Environment variables are set by whoever launches the command. In an MCP client config that is you. In a plain shell an agent can set them on its own command line, so use them as defaults you control, not as a guarantee against a hostile shell agent. `hallpass doctor` flags the ones that weaken a protection.

## FAQ

**Can the agent just read the password out of the page?** No. Typed values are cleared after entry, and the MCP tool refuses to read password fields. A shell agent can still call `agent-browser` directly, which is why the vault, not the browser, is the trust boundary. See [SECURITY.md](SECURITY.md).

**Does it solve CAPTCHAs?** No, on purpose. It hands them to you in a visible window.

**Does it send my data anywhere?** No. The vault, profiles and audit log live on your machine. Cloud browsers are opt-in. The one network request Hallpass makes by itself is the update check: at most once a day, a plain GET of `https://registry.npmjs.org/hallpass-browser/latest` (the public latest-version number). It sends no identifier, no version, no account or machine information; npm sees what any download sees, your IP address. Turn it off with `HALLPASS_NO_UPDATE_CHECK=1`.

**Do I have to store credentials?** No. The default is that *you* log in once in a visible window and the profile keeps the session.

**Can I stop it asking for confirmation every time?** Yes, deliberately: `hallpass access trusted <site>` turns the click and upload dialogs off on the sites you name, `hallpass access full` everywhere (for 4 hours unless you say otherwise). Only you can do it, from a terminal. The integrity checks (secrets unreadable, origin pinning, blocked commands, upload vetting) never switch off. See [How much it asks you](#how-much-it-asks-you-access-levels).

**I have two accounts on one site. Which one does the agent use?** It asks you which one, then uses `hallpass open <url> --as <name>`. See [Several accounts](#several-accounts-on-one-site).

**Which sites work?** Any site Chrome can open. Sign-in detection is heuristic (it ships a 28-page corpus in 7 languages), so when it guesses wrong it asks you instead of failing.

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
- **Access levels remove the pop-ups, which are the main defence against a web page that tries to make the agent click "Delete"**. Use `trusted` with named sites and a time limit rather than `full --forever`. Like the rest of the gate they stop a prompt-injected agent, not a hostile process running as you: a shell agent can still call `agent-browser` directly.
- The **action gate** is a heuristic on labels: it catches common dangerous buttons, not every one, and a shell agent can bypass it by calling `agent-browser` directly.
- `www.example.com` and `example.com` keep separate saved logins (they always have), and a local dev server on any port shares one saved login per hostname; use labels to tell accounts apart.
- Vaults are bound to one OS account; move machines with `export` / `import`.

## Contributing

Issues and pull requests are welcome, especially: **macOS and Linux testing**, **site recipes**, and **more sign-in detection fixtures**. Start with [CONTRIBUTING.md](CONTRIBUTING.md) and the [ROADMAP](ROADMAP.md); look for issues labelled `good first issue`. Please report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

If Hallpass saves you from pasting a password into a chat, a ⭐ helps other people find it.

[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) · [CHANGELOG.md](CHANGELOG.md) · MIT licensed ([LICENSE](LICENSE)).

Thanks to [agent-browser](https://github.com/vercel-labs/agent-browser) (browser control) and, optionally, [Obscura](https://github.com/h4ckf0r0day/obscura) (quick public reads).

Use it only on accounts you own and where automation is permitted by the site's terms. Hallpass does not solve CAPTCHAs or bypass bot protection: it hands them to you.
