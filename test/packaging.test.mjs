// Is what we would publish coherent? Metadata, every tool's native package, versions, and the npm tarball.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'hallpass.mjs');
const rd = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const json = (p) => JSON.parse(rd(p));
const exists = (p) => fs.existsSync(path.join(ROOT, p));
const pkg = json('package.json');

test('package metadata: name, bin, license, and every published path exists', () => {
  assert.equal(pkg.name, 'hallpass-browser');
  assert.equal(pkg.license, 'MIT');
  assert.ok(exists(pkg.bin.hallpass), 'bin target exists');
  assert.match(rd('LICENSE'), /^MIT License/);
  assert.ok(pkg.engines.node);
  for (const f of pkg.files) assert.ok(exists(f), `files entry exists: ${f}`);
  assert.equal(pkg.publishConfig.provenance, true);
});

test('one version everywhere', () => {
  const v = pkg.version;
  assert.equal(json('.claude-plugin/plugin.json').version, v, 'claude plugin');
  assert.equal(json('.codex-plugin/plugin.json').version, v, 'codex plugin');
  assert.equal(json('gemini-extension.json').version, v, 'gemini extension');
  assert.match(rd('src/mcp.mjs'), new RegExp(`const VERSION = '${v.replace(/\./g, '\\.')}'`), 'mcp server');
  assert.match(rd('CHANGELOG.md'), new RegExp(`^# Changelog\\s+## ${v.replace(/\./g, '\\.')}\\b`), 'changelog top entry');
  assert.equal(JSON.parse(spawnSync(process.execPath, [BIN, '--version'], { encoding: 'utf8' }).stdout).version, v, 'cli --version');
});

test('the skill every package bundles has valid frontmatter', () => {
  const s = rd('skills/hallpass/SKILL.md');
  const fm = /^---\n([\s\S]*?)\n---/.exec(s)?.[1] || '';
  assert.match(fm, /^name: hallpass$/m);
  assert.match(fm, /^description: .{40,}/m);
});

test('Claude Code plugin + marketplace: consistent, MCP points at a real file', () => {
  const plugin = json('.claude-plugin/plugin.json');
  const mkt = json('.claude-plugin/marketplace.json');
  assert.match(plugin.name, /^[a-z0-9]+(-[a-z0-9]+)*$/, 'kebab-case');
  assert.ok(!/^(claude|anthropic)/.test(plugin.name), 'does not pass as an Anthropic plugin');
  assert.ok(mkt.name && mkt.owner?.name && Array.isArray(mkt.plugins));
  const entry = mkt.plugins.find((p) => p.name === plugin.name);
  assert.ok(entry, 'marketplace entry name equals manifest name');
  assert.equal(entry.source, './');
  const mcp = json('.mcp.json').mcpServers.hallpass;
  assert.equal(mcp.command, 'node');
  const target = mcp.args[0].replace('${CLAUDE_PLUGIN_ROOT}/', '');
  assert.ok(exists(target), 'MCP script exists: ' + target);
  assert.equal(mcp.args[1], 'mcp');
  assert.match(rd('bin/hallpass'), /^#!\/bin\/sh\n[\s\S]*hallpass\.mjs/, 'PATH launcher');
});

test('claude plugin validate accepts the plugin and marketplace', { skip: spawnSync('claude', ['--version'], { shell: true }).status !== 0 && 'claude CLI not installed' }, () => {
  const r = spawnSync('claude', ['plugin', 'validate', '.'], { cwd: ROOT, encoding: 'utf8', shell: true, timeout: 400_000 });
  const out = r.stdout + r.stderr;
  assert.equal(r.status, 0, out);
  assert.match(out, /Validation passed/);
  assert.ok(!/Validation failed/.test(out), out);
});

test('Codex plugin + marketplace: follows the documented shape (not runnable here)', () => {
  const plugin = json('.codex-plugin/plugin.json');
  const mkt = json('.agents/plugins/marketplace.json');
  assert.equal(plugin.name, 'hallpass-browser');
  assert.equal(plugin.skills, './skills/');
  assert.ok(exists('skills'), 'skills dir');
  assert.ok(plugin.mcpServers.startsWith('./') && exists(plugin.mcpServers.slice(2)), 'mcp file');
  const srv = json(plugin.mcpServers.slice(2)).mcpServers.hallpass;
  assert.equal(srv.type, 'stdio'); // the portable format requires a transport type
  assert.deepEqual([srv.command, ...srv.args], ['hallpass', 'mcp']);
  assert.ok(plugin.interface.displayName && plugin.interface.category);
  const e = mkt.plugins.find((p) => p.name === plugin.name);
  assert.ok(e, 'marketplace entry');
  assert.equal(e.source.source, 'local');
  assert.ok(e.source.path.startsWith('./'));
  assert.ok(e.policy.installation && e.policy.authentication && e.category, 'required policy/category fields');
});

test('Gemini CLI extension: follows the documented shape (not runnable here)', () => {
  const m = json('gemini-extension.json');
  assert.match(m.name, /^[a-z0-9-]+$/);
  assert.equal(m.contextFileName, 'GEMINI.md');
  assert.ok(exists('GEMINI.md'));
  const s = m.mcpServers.hallpass;
  assert.equal(s.command, 'node');
  assert.ok(s.args[0].includes('${extensionPath}') && s.args[0].includes('${/}'), 'portable extension-relative path');
  assert.ok(exists('bin/hallpass.mjs') && exists('skills/hallpass/SKILL.md'), 'bundled skill + server exist');
  assert.ok(rd('GEMINI.md').length < 2500, 'context file stays small (it is loaded every session)');
});

test('npm tarball contains everything a user needs and nothing they should not get', () => {
  const r = spawnSync('npm', ['pack', '--dry-run', '--json'], { cwd: ROOT, encoding: 'utf8', shell: true, timeout: 400_000 });
  assert.equal(r.status, 0, r.stderr);
  const files = JSON.parse(r.stdout)[0].files.map((f) => f.path.replace(/\\/g, '/'));
  for (const must of ['LICENSE', 'README.md', 'SECURITY.md', 'CHANGELOG.md', 'package.json', 'bin/hallpass.mjs', 'skills/hallpass/SKILL.md', '.claude-plugin/plugin.json', '.claude-plugin/marketplace.json', '.codex-plugin/plugin.json', '.mcp.json', 'gemini-extension.json', 'GEMINI.md', 'src/login.mjs', 'src/sysexe.mjs']) {
    assert.ok(files.includes(must), 'missing from tarball: ' + must);
  }
  assert.ok(!files.some((f) => f.startsWith('test/') || f.startsWith('.github/') || f.includes('.hallpass') || /\.(pem|key|env)$/.test(f)), 'tests, CI config and anything sensitive stay out');
});

test('no stale names or placeholders in shipped text', () => {
  const skip = new Set(['CHANGELOG.md', 'ROADMAP.md']);
  const list = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' }).stdout.split('\n').filter((f) => /\.(md|json|mjs|yml)$/.test(f) && !skip.has(f) && !f.startsWith('test/'));
  assert.ok(list.length > 20, 'git file list available');
  for (const f of list) {
    const t = rd(f);
    assert.ok(!/keyhole/i.test(t), `${f} mentions the old name`);
    assert.ok(!/agent-hallpass/.test(t), `${f} mentions the old package name`);
  }
});

test('Antigravity installer writes a real skill where Antigravity reads it', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-ag-home-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-ag-cwd-'));
  const run = (...a) => JSON.parse(spawnSync(process.execPath, [BIN, ...a], { encoding: 'utf8', cwd, env: { ...process.env, HALLPASS_TARGET_HOME: home, HALLPASS_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'hp-ag-h-')) } }).stdout);
  const r = run('install', '--for', 'antigravity');
  const ide = path.join(home, '.gemini', 'config', 'skills', 'hallpass', 'SKILL.md');
  assert.equal(r.results[0].file, ide);
  assert.equal(fs.readFileSync(ide, 'utf8'), rd('skills/hallpass/SKILL.md'));
  assert.ok(!fs.existsSync(path.join(home, '.gemini', 'antigravity-cli')), 'the CLI home is not created unless it exists');
  fs.mkdirSync(path.join(home, '.gemini', 'antigravity-cli'), { recursive: true });
  const again = run('install', '--for', 'antigravity');
  assert.equal(again.results[0].action, 'updated', 'idempotent');
  assert.ok(fs.existsSync(path.join(home, '.gemini', 'antigravity-cli', 'skills', 'hallpass', 'SKILL.md')), 'CLI skill written once the CLI exists');
  run('install', '--for', 'antigravity-project');
  assert.ok(fs.existsSync(path.join(cwd, '.agents', 'skills', 'hallpass', 'SKILL.md')));
});

test('mcp-config: --npx prints the npm form for every client; default points at this checkout', () => {
  const get = (t, ...x) => spawnSync(process.execPath, [BIN, 'mcp-config', '--for', t, ...x], { encoding: 'utf8' }).stdout;
  for (const t of ['claude', 'cursor', 'gemini', 'antigravity', 'windsurf', 'vscode', 'codex']) {
    const npx = get(t, '--npx');
    assert.match(npx, /hallpass-browser/, t);
    assert.ok(!/hallpass\.mjs/.test(npx), t + ' --npx must not reference a local path');
    assert.match(get(t), /hallpass\.mjs/, t + ' default uses the local script');
  }
  assert.match(JSON.parse(get('antigravity')).file, /\.gemini\/config\/mcp_config\.json/);
});

test('README documents every supported tool', () => {
  const r = rd('README.md');
  for (const w of ['Claude Code', 'Codex', 'Gemini CLI', 'Antigravity', 'Cursor', 'hallpass-browser', 'npm i -g hallpass-browser', 'MIT']) assert.ok(r.includes(w), 'README mentions ' + w);
});
