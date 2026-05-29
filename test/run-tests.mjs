import { build } from 'esbuild';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const tempDir = path.join(process.cwd(), '.tmp-tests');
const outfile = path.join(tempDir, 'shared.spec.mjs');

async function main() {
  await rm(tempDir, { recursive: true, force: true });
  await mkdir(tempDir, { recursive: true });

  await build({
    entryPoints: [path.join(process.cwd(), 'test', 'shared.spec.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node18',
    outfile
  });

  const mod = await import(pathToFileURL(outfile).href);
  mod.runAllTests();
  console.log('Shared and i18n tests passed.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
