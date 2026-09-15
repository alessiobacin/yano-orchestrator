import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
export function buildFingerprint(root) {
  const hash = crypto.createHash('sha256');
  function visit(relative) {
    const file = path.join(root, relative);
    if (!fs.existsSync(file)) return;
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) for (const child of fs.readdirSync(file).sort()) visit(path.join(relative, child));
    else { hash.update(relative); hash.update('\0'); hash.update(fs.readFileSync(file)); }
  }
  for (const name of ['package.json','bin','scripts','extensions','prompts','agents','playbooks','skills-vendor']) visit(name);
  return { root, version: JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).version, fingerprint: hash.digest('hex') };
}
