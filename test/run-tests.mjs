import { build } from 'esbuild';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const tempDir = path.join(process.cwd(), '.tmp-tests');
const outfile = path.join(tempDir, 'all.spec.mjs');

async function main() {
  await rm(tempDir, { recursive: true, force: true });
  await mkdir(tempDir, { recursive: true });

  await build({
    entryPoints: [path.join(process.cwd(), 'test', 'all.spec.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node18',
    external: ['@copilotkit/aimock', '@copilotkit/aimock/jest', 'msw', 'msw/node'],
    outfile
  });

  const mod = await import(pathToFileURL(outfile).href);
  await mod.runAllTests();
  console.log('Shared, i18n, provider, and LLM mock tests passed.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
