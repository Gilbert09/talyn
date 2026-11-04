import { createHash } from 'crypto';
import { shellQuote } from '@talyn/shared';
import type { writeSandboxFiles, SandboxFile } from './sandboxFiles.js';
import type { WorkbenchRow } from './store.js';

type Slot = 'instructions-claude' | 'instructions-codex' | 'skills';
const slots: Slot[] = ['instructions-claude', 'instructions-codex', 'skills'];
const cache = new Map<string, Partial<Record<Slot, { source: string; disk: string }>>>();
const observed = new Map<string, Partial<Record<Slot, string>>>();
const clean = new Map<string, Set<Slot>>();
const writes = new Map<string, Promise<void>>();
const keyFor = (row: WorkbenchRow) => JSON.stringify([row.id, row.sandboxId, row.sandboxGeneration, row.fleetHost]);
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Hash the managed files and the repository files that the sync reads. Missing files also affect the hash. */
export function sessionFileProbe(repoDir: string, only: Slot[] = slots): string {
  const script = `
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const home = process.env.HOME, repo = ${JSON.stringify(repoDir)};
let gitDir;
try { gitDir = require('child_process').execFileSync('git', ['rev-parse','--absolute-git-dir'], {cwd:repo,encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim(); } catch {}
function ownership(stamp) {
  if(!gitDir) return null;
  const common = read(path.join(gitDir,'commondir'));
  const excludeDir = common ? path.resolve(gitDir,common.trim()) : gitDir;
  return [read(path.join(excludeDir,'info/exclude')), read(path.join(gitDir,stamp))];
}
function read(p) { try { return fs.readFileSync(p, 'utf8'); } catch(e) { if(e.code === 'ENOENT') return null; throw e; } }
function tree(p) {
  let st; try { st = fs.lstatSync(p); } catch(e) { if(e.code === 'ENOENT') return null; throw e; }
  if(st.isSymbolicLink()) throw new Error('uncertain symlink');
  return st.isDirectory() ? fs.readdirSync(p).sort().map(n => [n, tree(path.join(p,n))]) : read(p);
}
const codex = read(path.join(home, '.codex/AGENTS.md'));
function skills(root) {
  let names; try { names = fs.readdirSync(root); } catch(e) { if(e.code === 'ENOENT') return null; throw e; }
  return names.filter(n => n.startsWith('talyn-')).sort().map(n => [n, tree(path.join(root,n,'SKILL.md')), read(path.join(root,n,'.talyn-skill-pack'))]);
}
for(const slot of ${JSON.stringify(only)}) {
  try {
    let value;
    let isClean = false;
    if(slot === 'skills') value = [skills(path.join(home,'.claude/skills')), skills(path.join(home,'.codex/skills')), read(path.join(home,'.claude/rules/talyn.md')), codex];
    else if(slot === 'instructions-codex') { value = [codex, read(path.join(repo,'AGENTS.md')), read(path.join(repo,'AGENTS.override.md')), ownership('talyn-agents-override')]; { const o = ownership('talyn-agents-override'); isClean = !(codex||'').includes('<!-- talyn:instructions:start -->') && !read(path.join(repo,'AGENTS.override.md')) && !(o && o[1]); } }
    else {
      const dir = path.join(home,'.claude/rules');
      let names; try { names = fs.readdirSync(dir); } catch(e) { if(e.code !== 'ENOENT') throw e; names = []; }
      value = [names.filter(n => /^talyn-.*\\.md$/.test(n)).sort().map(n => [n,tree(path.join(dir,n))]), read(path.join(repo,'CLAUDE.local.md')), ownership('talyn-claude-local')];
      isClean = value[0].length === 0 && value[1] === null && !(value[2] && value[2][1]);
    }
    console.error('TALYN_FILE_HASH '+slot+' '+crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'));
    if(isClean) console.error('TALYN_FILE_CLEAN '+slot);
  } catch {}
}`;
  return `node -e ${shellQuote(script)} || true`;
}

function hashes(output: string): Partial<Record<Slot, string>> {
  const result: Partial<Record<Slot, string>> = {};
  for (const slot of slots) {
    const match = new RegExp('^TALYN_FILE_HASH ' + slot + ' ([a-f0-9]{64})$', 'm').exec(output);
    if (match) result[slot] = match[1];
  }
  return result;
}

/** Called by the first exec. Missing probe output forces a sync. */
export function observeSessionFiles(row: WorkbenchRow, output: string): void {
  if (observed.size >= 1000) { observed.clear(); clean.clear(); }
  observed.set(keyFor(row), hashes(output));
  clean.set(keyFor(row), new Set(slots.filter((s) => new RegExp('^TALYN_FILE_CLEAN ' + s + '$', 'm').test(output))));
}

/** Serialize shared writes. Cache only a complete sync with a known disk hash. */
export async function syncSessionFiles(
  row: WorkbenchRow, slot: Slot, source: unknown,
  plan: [SandboxFile[], { before?: string; after: string }],
  io: { repoDir: string; write: typeof writeSandboxFiles },
): Promise<void> {
  const key = keyFor(row);
  const lockKey = slot === 'instructions-claude' ? `${key}:claude` : `${key}:codex`;
  const prior = writes.get(lockKey) ?? Promise.resolve();
  const job = prior.catch(() => undefined).then(async () => {
    const sourceHash = hash(source);
    const previous = cache.get(key)?.[slot];
    const disk = observed.get(key)?.[slot];
    if (disk && previous?.source === sourceHash && previous.disk === disk) return;
    // Nothing to write and nothing of ours on the box: there is nothing to clear either.
    if (plan[0].length === 0 && slot !== 'skills' && clean.get(key)?.has(slot)) return;
    const entry = cache.get(key) ?? {};
    cache.set(key, entry);
    delete entry[slot];
    clean.get(key)?.delete(slot);
    // A partial write also invalidates the shared file observation.
    const seen = observed.get(key);
    if (seen) {
      delete seen[slot];
      if (slot === 'skills') delete seen['instructions-codex'];
      if (slot === 'instructions-codex') delete seen.skills;
    }
    let after: string | undefined;
    await io.write(row, plan[0], {
      ...plan[1],
      after: `${plan[1].after}\n${sessionFileProbe(io.repoDir, [slot])}`,
      onLastOutput: (output) => { after = hashes(output)[slot]; },
    });
    if (after) entry[slot] = { source: sourceHash, disk: after };
    if (cache.size >= 1000) cache.clear();
    cache.set(key, entry);
  });
  writes.set(lockKey, job);
  try { await job; } finally { if (writes.get(lockKey) === job) writes.delete(lockKey); }
}
