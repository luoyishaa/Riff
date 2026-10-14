import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = process.cwd();
const rules = [
  ['packages/review', ['@collab/agent', 'apps/server', 'apps/web']],
  ['packages/agent', ['apps/server', 'apps/web']],
  ['packages/kernel', ['@collab/review', '@collab/agent', 'apps/server', 'apps/web']],
  ['packages/protocol', ['@collab/kernel', '@collab/review', '@collab/agent']]
];
const violations = [];
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (entry === 'node_modules' || entry === 'dist') continue;
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else if (/\.(ts|tsx|mjs)$/.test(entry)) out.push(path);
  }
  return out;
}
for (const [folder, forbidden] of rules) {
  for (const file of walk(join(root, folder))) {
    const text = readFileSync(file, 'utf8');
    for (const target of forbidden) if (text.includes(`from '${target}`) || text.includes(`from \"${target}`)) violations.push(`${relative(root, file)} imports ${target}`);
  }
}
if (violations.length) { console.error(violations.join('\n')); process.exit(1); }
console.log('package boundaries ok');
