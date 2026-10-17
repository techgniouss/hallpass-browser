# Hallpass roadmap (audit of gaps and enhancements)

Ranked by value to a user who wants "open anything, log in safely, do the task". Effort: S (hours), M (a day or two), L (a week+).
Status reflects the code as it is today; nothing here is claimed to exist unless marked **done**.

## Tier 1: closes real risks or the biggest usability gaps

| # | Enhancement | Why | Effort |
|---|---|---|---|
| 1 | **Per-use human approval** for stored credentials (`add --require-approval`): before unsealing, show a native OS prompt ("Claude wants to sign in to supabase.com. Allow once / 1 hour / deny"). | Today any process that can call `hallpass open` can use any credential silently. This is also what 1Password's agent integration does (approval in its own UI, plus an "agent mode" limited to approved items). It is the best single mitigation for prompt-injected agents and for the same-user limitation in SECURITY.md. | M |
| 2 | **Just-in-time credential entry** (`hallpass_request_credential` MCP tool + `hallpass open` hint): opens a one-time localhost form (random port, 256-bit path token, expires in 5 min) in the user's browser; the user types the password; the agent never sees it. | `hallpass add` needs a terminal, which MCP-only IDE agents and web-style UIs don't have, and "add everything upfront" is the friction you called out. | M |
| 3 | **Password-manager references** (`add --from op://Vault/Item`, Bitwarden `bw`, `pass`, KeePass): store a *reference*; resolve at login by calling the manager's CLI (which does its own biometric unlock). | No re-typing, no second copy of secrets, rotation just works, TOTP via `op item get --otp`. | M |
| 4 | **Hard action gate** for irreversible steps, enforced by the tool, not just the instruction text: map to agent-browser's `--confirm-actions` / action-policy and expose `hallpass_confirm` / `hallpass_deny`. | Today "stop before Submit/Delete/Pay" depends on the model obeying the skill. | M |
| 5 | **Privilege-separated broker** (optional): vault + unseal run in a separate OS user/service; the agent talks to it over a named pipe / unix socket. | The only real answer to "same-user process can decrypt the vault". | L |
| 6 | **Cross-OS CI** (GitHub Actions matrix: Windows, macOS, Linux) + a Linux fallback keystore when libsecret is absent (passphrase or systemd-creds). | macOS/Linux code paths are unexecuted today; containers and servers have no keyring. | M |

## Tier 2: broader coverage of "any site"

| # | Enhancement | Why | Effort |
|---|---|---|---|
| 7 | **Site recipes** (JSON): per-site selectors/steps/success checks for tricky logins; ship built-ins (Google, Microsoft, AWS account-ID + IAM user, Okta, Auth0, Keycloak, Cognito). | Heuristics cover the common single/two-step case; recipes cover the long tail without touching code. | M |
| 8 | **iframe and shadow-DOM logins**: traverse open shadow roots in the probe, switch frames for fill. | Today these fail safe (nothing typed, handed to the human), but can't be automated. | M |
| 9 | **Passkeys / WebAuthn**: software authenticator via the CDP WebAuthn domain (virtual authenticator), credentials sealed in the vault. | More sites are passkey-first. Needs CDP access beyond what agent-browser's CLI exposes, so this depends on upstream or a direct CDP client. | L |
| 10 | **Email/SMS one-time codes**: structured human handoff ("enter the code from your email in the window") already works; optionally read codes from a connected mailbox with explicit user approval. | Common 2FA that TOTP doesn't cover. Reading mail is sensitive, so approval-gated. | M |
| 11 | **Localisation** of the login/MFA/captcha detectors (currently English text heuristics; field detection already prefers `autocomplete`/`type`). | Non-English sites degrade to "unknown page" and hand over. | S-M |
| 12 | **Remote/cloud browsers** (`--provider browserbase|kernel|browserless`): pass through; credentials still injected locally. | Servers/CI with no display. | S |

## Tier 3: operations and trust

| # | Enhancement | Why | Effort |
|---|---|---|---|
| 13 | **Audit log** (`hallpass log`): append-only record of every open/login/handoff/browser command, no secrets, with origin and result. | Lets you see exactly what an agent did with your logins. | S |
| 14 | **Desktop notification + window focus** when a handoff is needed. | In background runs you may not notice the window opened. | S |
| 15 | **Credential policy**: expiry, max uses, allowed hours; **read-only sessions** for MCP (`browser` limited to snapshot/get/find). | Least privilege for "just look at my dashboard" tasks. | S-M |
| 16 | **Session hygiene commands**: `hallpass sessions` (age, last URL, size), `prune`, auto re-login hint when a session expires mid-task. | Visibility and cleanup. | S |
| 17 | **Encrypted export/import** with a passphrase, for moving machines (vault is OS-bound today). | Backup/migration. | M |
| 18 | **Packaging**: publish to npm, single-file binaries, winget/scoop/Homebrew; release notes; LICENSE choice; CONTRIBUTING; issue templates. | Distribution beyond "clone and `npm link`". | M |
| 19 | **Detection test corpus**: saved HTML fixtures of real login pages (GitHub, Google, Microsoft, Okta, Auth0, WordPress, Shopify...) to measure detector accuracy offline. | Turns "heuristic" into a measured number and guards regressions. | M |
| 20 | **`hallpass init` wizard / `hallpass ui`**: detect installed AI tools, offer the right `install` + MCP config with consent; small management UI. | Onboarding. | M |

## Status after the "build all" pass

| # | Item | Status |
|---|---|---|
| 1 | Per-use approval | **done** (+ expiry, max uses) |
| 2 | Just-in-time credential entry | **done** |
| 3 | Password-manager references | **done** (1Password, Bitwarden, pass; tested with stand-in CLIs, not real accounts) |
| 4 | Hard action gate | **done** for MCP `browser` and `hallpass do` (heuristic) |
| 5 | Separate-user broker | not built: needs OS account/service setup and design review |
| 6 | Cross-OS CI + Linux keystore fallback | file keystore **done**; CI workflow **written, never run** |
| 7 | Site recipes | not built |
| 8 | iframe / shadow-DOM logins | not built (fails safe) |
| 9 | Passkeys / WebAuthn | not built: needs CDP access the CLI does not expose |
| 10 | Email/SMS code reading | not built on purpose (reading mail needs its own consent model); handoff to the person works |
| 11 | Localisation | **done** for es, de, fr, pt, it, nl (28-page corpus) |
| 12 | Cloud browser providers | works via agent-browser env passthrough; untested here |
| 13 | Audit log | **done** |
| 14 | Notifications | **done** (Windows verified only to launch without error) |
| 15 | Credential policy, read-only | **done** |
| 16 | Session hygiene | **done** (`sessions`, `prune`) |
| 17 | Encrypted export/import | **done** |
| 18 | Packaging | scripts, changelog, CI file done; **npm publish and binaries intentionally not done** |
| 19 | Detection corpus | **done** (28 fixtures) |
| 20 | init wizard | **done** (CLI; no UI) |

## Done in the earlier audit

- **Lockout protection across invocations**: after a rejected password/TOTP, automatic login is refused (`credential_locked`) until a human runs `hallpass add NAME --force` or `hallpass unlock NAME`. Previously an agent could call `open` repeatedly and lock the real account.
- Closed-window / blank-page / unreachable-site handling, lost-master-key guard, www-to-apex redirect tolerance, untrusted-text capping, hostile-password regression test (each has a regression test).

## Verified facts the design relies on

- Chrome 136+ ignores `--remote-debugging-port` on the default profile (needs a separate `--user-data-dir`): [Chrome for Developers](https://developer.chrome.com/blog/remote-debugging-port). This is why Hallpass runs its own managed profile instead of attaching to your everyday Chrome.
- Comparable products (e.g. [1Password Secure Agentic Autofill](https://1password.com/blog/closing-the-credential-risk-gap-for-browser-use-ai-agents)) inject credentials on-device after human approval and note that hiding the secret does not constrain what the agent can do with the logged-in session. Hallpass has the same property; Tier 1 items 1 and 4 address it.
