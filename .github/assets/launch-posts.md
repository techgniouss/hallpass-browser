# Launch post drafts (not shipped in the npm package)

Ground rules: be upfront that it is beta, say what is tested and what is not, link the threat model, answer every comment.

## Show HN

**Title:** Show HN: Hallpass – let AI agents log in to sites without being able to read your password

**Body:**
I kept ending up pasting passwords into agent chats, or doing the login myself and hoping the session survived. Hallpass is the third option: the agent gets a logged-in browser and never sees the secret.

- Logins live in a sealed vault (AES-GCM, key sealed by the OS). The agent can use a login, not read it.
- A password is only typed into the exact origin you approved.
- CAPTCHA, push-MFA, passkeys and first logins open a visible window for *you*. It never fights a CAPTCHA and never types for you.
- Delete/Publish/Pay-style clicks need a native confirmation from you.
- CLI that prints JSON + an MCP server + plugins for Claude Code, Codex and Gemini CLI. Built on Vercel's agent-browser.

`npm i -g hallpass-browser` — then ask your agent to open a dashboard.

It is beta, has not been independently audited, and the threat model (including what it does NOT protect against) is in SECURITY.md. macOS/Linux pass CI but the native keychain/dialog paths are untested by hand; I would love help there.

https://github.com/techgniouss/hallpass-browser

## r/ClaudeAI (or r/ClaudeCode)

**Title:** I made a Claude Code plugin so Claude can use my logged-in browser without ever seeing my passwords

Short version of the HN text, then: `/plugin marketplace add techgniouss/hallpass-browser` and `/plugin install hallpass-browser@hallpass-browser`. Mention the human hand-off for CAPTCHA/MFA, and ask for feedback on the action gate (which clicks should always need a confirmation?).

## X / LinkedIn

Agents are great until they need to log in. Pasting a password into a chat is a bad idea; doing it yourself every time defeats the point.

Hallpass: agent gets the logged-in browser, never the password. Sealed vault, origin pinning, human hand-off for CAPTCHA/MFA, a gate on irreversible clicks. Open source, MIT.

npm i -g hallpass-browser
github.com/techgniouss/hallpass-browser

## Timing and etiquette

- Post HN on a weekday morning US Pacific; do not ask for upvotes anywhere.
- Be present for the first few hours to answer questions.
- Lead with the problem, not the feature list; admit the limits before commenters do.
