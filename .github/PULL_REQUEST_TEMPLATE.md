## What and why

## Safety check
- [ ] No new way for an agent to read a stored secret, and no new command/flag/env var/tool parameter that weakens a human-only rule (if it touches the security-sensitive files in CONTRIBUTING.md, explain)
- [ ] Bug fix has a regression test that failed before the fix
- [ ] No real secrets in code, tests, fixtures or logs

## Verification
- [ ] `npm test` passes
- [ ] `npm run test:browser` passes (or explain why it could not be run)
- [ ] Docs, `CHANGELOG.md`, and `skills/hallpass/SKILL.md` updated if behavior changed
- [ ] Versions still match across package.json / plugin manifests / src/mcp.mjs
