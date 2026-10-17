// Teaches each AI tool how to use hallpass (instruction files) and prints the MCP config for each client.
// Instruction files are written only inside a clearly marked block (or a file hallpass owns); nothing else is touched.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BEGIN = '<!-- hallpass:begin (managed by `hallpass install`; edits inside are overwritten) -->';
const END = '<!-- hallpass:end -->';

const skillFile = () => path.join(ROOT, 'skills', 'hallpass', 'SKILL.md');
const stripFrontmatter = (t) => t.replace(/^---[\s\S]*?\n---\n/, '');

const MCP_NOTE = `
## If hallpass is available as MCP tools

Use the tools instead of the shell commands above: \`hallpass_open\` (= \`hallpass open\`), \`hallpass_resume\`, \`hallpass_status\`, \`hallpass_logout\`, \`hallpass_list\`, and \`hallpass_request_credential\` (= \`hallpass request\`: the user types a login into a form, you never see it), then drive the page with the \`browser\` tool (\`command\` is the argv array you would pass to \`agent-browser --session <session>\`; risky clicks are confirmed by the user) and \`browser_screenshot\`. The rules above apply unchanged.
`;

export function instructionBody() {
  return `# hallpass: open any site and log in safely\n` + stripFrontmatter(fs.readFileSync(skillFile(), 'utf8')).replace(/^# hallpass[^\n]*\n/, '') + MCP_NOTE;
}

function upsertBlock(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const block = `${BEGIN}\n${body.trim()}\n${END}\n`;
  let cur = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const re = new RegExp(`${BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n?`);
  let action;
  if (re.test(cur)) { cur = cur.replace(re, block); action = 'updated'; }
  else { cur = (cur && !cur.endsWith('\n') ? cur + '\n' : cur) + (cur ? '\n' : '') + block; action = cur === block ? 'created' : 'appended'; }
  fs.writeFileSync(file, cur);
  return action;
}

function ownFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const action = fs.existsSync(file) ? 'updated' : 'created';
  fs.writeFileSync(file, content);
  return action;
}

export const TARGETS = {
  claude: { desc: 'Claude Code / Claude Desktop skill', run: ({ home }) => { const f = path.join(home, '.claude', 'skills', 'hallpass', 'SKILL.md'); fs.mkdirSync(path.dirname(f), { recursive: true }); const a = fs.existsSync(f) ? 'updated' : 'created'; fs.copyFileSync(skillFile(), f); return { file: f, action: a }; } },
  codex: { desc: 'OpenAI Codex CLI / IDE (global AGENTS.md)', run: ({ home }) => { const f = path.join(home, '.codex', 'AGENTS.md'); return { file: f, action: upsertBlock(f, instructionBody()) }; } },
  gemini: { desc: 'Gemini CLI (global GEMINI.md)', run: ({ home }) => { const f = path.join(home, '.gemini', 'GEMINI.md'); return { file: f, action: upsertBlock(f, instructionBody()) }; } },
  // Antigravity reads real skills (progressive disclosure: only the description is loaded until it is relevant).
  // Locations confirmed against the docs AND a working Antigravity IDE install: ~/.gemini/config/skills/<name>/SKILL.md (IDE),
  // ~/.gemini/antigravity-cli/skills/<name>/SKILL.md (CLI, written only if the CLI home exists).
  antigravity: { desc: 'Google Antigravity IDE/CLI (global skill)', run: ({ home }) => {
    const put = (f) => { fs.mkdirSync(path.dirname(f), { recursive: true }); const a = fs.existsSync(f) ? 'updated' : 'created'; fs.copyFileSync(skillFile(), f); return a; };
    const ide = path.join(home, '.gemini', 'config', 'skills', 'hallpass', 'SKILL.md');
    const out = { file: ide, action: put(ide) };
    if (fs.existsSync(path.join(home, '.gemini', 'antigravity-cli'))) { const cli = path.join(home, '.gemini', 'antigravity-cli', 'skills', 'hallpass', 'SKILL.md'); out.also = [{ file: cli, action: put(cli) }]; }
    return out;
  } },
  'antigravity-project': { desc: 'Google Antigravity (this workspace: .agents/skills/hallpass)', run: ({ cwd }) => {
    const f = path.join(cwd, '.agents', 'skills', 'hallpass', 'SKILL.md'); fs.mkdirSync(path.dirname(f), { recursive: true });
    const a = fs.existsSync(f) ? 'updated' : 'created'; fs.copyFileSync(skillFile(), f); return { file: f, action: a };
  } },
  cursor: { desc: 'Cursor (project rule .cursor/rules/hallpass.mdc)', run: ({ cwd }) => { const f = path.join(cwd, '.cursor', 'rules', 'hallpass.mdc'); return { file: f, action: ownFile(f, `---\ndescription: Open websites and log in safely with hallpass (use when a task needs a logged-in browser or a site login)\nalwaysApply: false\n---\n\n${instructionBody()}`) }; } },
  windsurf: { desc: 'Windsurf (project rule .windsurf/rules/hallpass.md)', run: ({ cwd }) => { const f = path.join(cwd, '.windsurf', 'rules', 'hallpass.md'); return { file: f, action: ownFile(f, `---\ntrigger: model_decision\ndescription: Open websites and log in safely with hallpass (use when a task needs a logged-in browser or a site login)\n---\n\n${instructionBody()}`) }; } },
  copilot: { desc: 'GitHub Copilot (project .github/copilot-instructions.md)', run: ({ cwd }) => { const f = path.join(cwd, '.github', 'copilot-instructions.md'); return { file: f, action: upsertBlock(f, instructionBody()) }; } },
  agents: { desc: 'Any tool that reads AGENTS.md (project AGENTS.md)', run: ({ cwd }) => { const f = path.join(cwd, 'AGENTS.md'); return { file: f, action: upsertBlock(f, instructionBody()) }; } },
};

export function install(target, { home = process.env.HALLPASS_TARGET_HOME || os.homedir(), cwd = process.cwd() } = {}) {
  const names = target === 'all' ? Object.keys(TARGETS) : [target];
  const results = [];
  for (const n of names) {
    if (!TARGETS[n]) throw new Error(`unknown target "${n}". Choose: ${Object.keys(TARGETS).join(', ')}, all`);
    results.push({ target: n, ...TARGETS[n].run({ home, cwd }) });
  }
  return results;
}

// ---- MCP client configuration (printed, never written: we do not edit your tools' config files) ----
export function mcpConfig(target, { npx = false } = {}) {
  const script = path.join(ROOT, 'bin', 'hallpass.mjs');
  // --npx: for people who installed from npm (`npx -y hallpass-browser mcp`); default points at this checkout's script
  const server = npx ? { command: 'npx', args: ['-y', 'hallpass-browser', 'mcp'] } : { command: 'node', args: [script, 'mcp'] };
  const std = (file, extra = '') => ({ file, format: 'json', snippet: { mcpServers: { hallpass: server } }, note: `Merge into ${file}.${extra}` });
  const cfg = {
    claude: { command: npx ? 'claude mcp add hallpass -- npx -y hallpass-browser mcp' : `claude mcp add hallpass -- node "${script}" mcp`, note: 'Run once in a terminal (Claude Code). For Claude Desktop use the JSON in claude_desktop_config.json: { "mcpServers": { "hallpass": { "command": "node", "args": ["<script>", "mcp"] } } }' },
    cursor: std('~/.cursor/mcp.json (or .cursor/mcp.json in a project)'),
    gemini: std('~/.gemini/settings.json', ' Or install it as a Gemini CLI extension: gemini extensions install <repo-url> (bundles the skill and this server).'),
    antigravity: std('~/.gemini/config/mcp_config.json (global, IDE and CLI) or .agents/mcp_config.json (this workspace)', ' Same file Settings > Customizations > Installed MCP Servers edits. Use absolute paths: variable expansion is not documented.'),
    windsurf: std('~/.codeium/windsurf/mcp_config.json'),
    vscode: { file: '.vscode/mcp.json (VS Code / GitHub Copilot agent mode)', format: 'json', snippet: { servers: { hallpass: { type: 'stdio', ...server } } }, note: 'Create .vscode/mcp.json with this content.' },
    codex: { file: '~/.codex/config.toml', format: 'toml', snippet: `[mcp_servers.hallpass]\ncommand = ${JSON.stringify(server.command)}\nargs = ${JSON.stringify(server.args)}\ntool_timeout_sec = 180\n`, note: 'Append to ~/.codex/config.toml. tool_timeout_sec raises the per-call limit (a login can take ~60s).' },
  };
  if (!cfg[target]) throw new Error(`unknown target "${target}". Choose: ${Object.keys(cfg).join(', ')}`);
  return { target, ...cfg[target] };
}
export const MCP_TARGETS = ['claude', 'cursor', 'gemini', 'antigravity', 'windsurf', 'vscode', 'codex'];
