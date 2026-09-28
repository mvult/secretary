import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const temp = await mkdtemp(join(tmpdir(), 'secretary-api-'));
async function files(directory: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(entry => entry.isDirectory()
    ? files(join(directory, entry.name), `${prefix}${entry.name}/`)
    : [`${prefix}${entry.name}`]))).flat().sort();
}
try {
  const result = Bun.spawnSync(['buf', 'generate', 'backend/proto', '--template', 'buf.gen.frontend.yaml', '--output', temp], { cwd: root, stdout: 'inherit', stderr: 'inherit' });
  if (result.exitCode) throw new Error('API generation failed');
  const expected = join(temp, 'packages/api/src/gen');
  const actual = join(root, 'packages/api/src/gen');
  const names = await files(expected);
  if (JSON.stringify(names) !== JSON.stringify(await files(actual))) throw new Error('Generated API file set differs; run bun run api:generate');
  for (const name of names) {
    if (!(await readFile(join(expected, name))).equals(await readFile(join(actual, name)))) throw new Error(`Generated API drift: ${name}`);
  }
  console.log('Generated API matches protobuf sources.');
} finally { await rm(temp, { recursive: true, force: true }); }
