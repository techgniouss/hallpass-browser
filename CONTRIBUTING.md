# Contributing to Hallpass Browser

Thanks for helping. This is a security-sensitive tool, so a few rules are stricter than usual.

## Ground rules

1. **Never put a real secret anywhere**: not in code, tests, fixtures, issues, screenshots or logs. Tests use fake credentials against local mock sites.
2. **The central guarantee must not weaken.** An agent can *use* a credential but must have no path to *read* it. Any change that adds a command, flag, env var, tool parameter or output field is reviewed against that. If it touches `src/login.mjs`, `src/vault.mjs`, `src/policy.mjs`, `src/act.mjs`, `src/mcp.mjs`, `src/ab.mjs`, `src/ui.mjs`, `src/sysexe.mjs` or `src/request.mjs`, say how the guarantee is preserved in the PR.
3. **Human-only means human-only.** Anything that changes trust (replace/remove a login, unlock, export, import, register a password-manager reference, re-pin the browser binary) must require a real terminal or a native dialog the agent cannot click, and fail closed.
4. **No new runtime dependencies** without a strong reason. Zero dependencies is a supply-chain feature.
5. **Tell the truth in docs.** If you could not run something (a platform, a client), say so. See how the README's "Checked" column is written.

## Setup

```bash
git clone <your fork> && cd hallpass-browser
npm i -g agent-browser && agent-browser install     # one-time
npm test                                            # fast, no browser
npm run test:browser                                # real Chrome against local mock sites
```

Node 20+. On Linux/macOS CI runners without an OS keyring set `HALLPASS_KEYSTORE=file` (see `.github/workflows/ci.yml`).

## Tests

- Every bug fix gets a regression test that **fails before the fix**. Show it failing.
- Security properties get adversarial tests (the attack, not just the happy path): see `test/trust.test.mjs`, `test/request.test.mjs`, `test/gate.test.mjs`.
- Browser tests must not block the mock site's event loop: run it in a child process (`test/site-proc.mjs`).
- Never use `spawnSync` with piped stdio on `agent-browser` (its daemon inherits the pipe); `src/ab.mjs` shows the working pattern.
- Detection changes: add a fixture to `test/fixtures.mjs` first.

## Pull requests

- Small and focused. Update `CHANGELOG.md`. Update `skills/hallpass/SKILL.md` if agent-facing behavior changes.
- Keep `package.json`, `.claude-plugin/plugin.json`, `gemini-extension.json`, `.codex-plugin/plugin.json` and `src/mcp.mjs` on the same version (a test enforces it).
- Run `npm test` and `npm run test:browser` and paste the summary.

## Reporting security issues

**Do not open a public issue.** See [SECURITY.md](SECURITY.md).

## License

By contributing you agree your contribution is licensed under the project's MIT license.
