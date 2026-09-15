import fs from 'node:fs';
import path from 'node:path';
import { globalDataPath } from './yano-config.mjs';
import { canonicalProjectRoot } from './yano-capabilities.mjs';
import { projectKey } from './yano-trace-storage.mjs';

const modes = new Set(['off', 'lite', 'full', 'ultra']);
const skill = fs.readFileSync(new URL('../skills-vendor/ponytail/ponytail/SKILL.md', import.meta.url), 'utf8').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
function policyFile(root, global = false) {
  return path.join(globalDataPath(), 'ponytail', global ? 'global.json' : `${projectKey(canonicalProjectRoot(root))}.json`);
}
function readMode(file) {
  try {
    const mode = JSON.parse(fs.readFileSync(file, 'utf8')).mode;
    if (!modes.has(mode)) throw new Error(`Ponytail: modalità non valida in ${file}`);
    return mode;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
export function ponytailPolicy(root = process.cwd()) {
  const projectMode = readMode(policyFile(root));
  const globalMode = readMode(policyFile(root, true));
  const mode = projectMode ?? globalMode ?? 'full';
  return { mode, enabled: mode !== 'off', source: projectMode !== null ? 'project' : globalMode !== null ? 'global' : 'default', project_mode: projectMode, global_mode: globalMode ?? 'full' };
}
export function ponytailPrompt(root = process.cwd(), policy = ponytailPolicy(root)) {
  if (!policy.enabled) return '\n\nYano coding policy: automatic Ponytail is disabled by user preference. Do not reactivate it unless requested.\n';
  return `\n\n## Yano shared skill: Ponytail (${policy.mode})\nPonytail is an authorized shared capability for EVERY Yano role, additional to the role roster. Apply it to coding, design and review work every turn, including custom prompts. The selected intensity is ${policy.mode}; this overrides the upstream default below. User requests, correctness, safety and required checks take precedence. If the user asks to stop Ponytail, honor that immediately and persist with \`yano ponytail off --project-root ${JSON.stringify(canonicalProjectRoot(root))}\` unless they request a session-only change. To resume use \`yano ponytail on\`.\n\n${skill}`;
}
export function runPonytail({ cwd = process.cwd(), argv = [] } = {}) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('Uso: yano ponytail [status|on|off|lite|full|ultra|reset] [--global] [--project-root DIR]\nDefault full per tutti i ruoli. reset rimuove l’override; le preferenze di progetto prevalgono su quelle globali.');
    return;
  }
  const index = argv.indexOf('--project-root');
  if (index >= 0 && (!argv[index + 1] || argv[index + 1].startsWith('--'))) throw new Error('--project-root richiede una directory');
  const root = index >= 0 ? argv[index + 1] : cwd;
  const action = argv[0]?.startsWith('--') ? 'status' : argv[0] || 'status';
  const mode = action === 'on' ? 'full' : action;
  const file = policyFile(root, argv.includes('--global'));
  if (action === 'reset') fs.rmSync(file, { force: true });
  else if (action !== 'status') {
    if (!modes.has(mode)) throw new Error(`Modalità Ponytail non valida: ${action}`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ mode }) + '\n', { mode: 0o600 });
    fs.renameSync(temporary, file);
  }
  const result = { ...ponytailPolicy(root), scope: argv.includes('--global') ? 'global' : 'project', path: file };
  console.log(JSON.stringify(result, null, 2));
  return result;
}
