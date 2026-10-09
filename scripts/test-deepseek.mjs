import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const envPath = fileURLToPath(new URL('../.env', import.meta.url));
// Keep externally supplied variables authoritative, including CI secrets.
const inherited = { ...process.env };
if (existsSync(envPath)) loadEnvFile(envPath);
Object.assign(process.env, inherited);
process.env.DEEPSEEK_API_KEY =
  process.env.DEEPSEEK_API_KEY?.trim() || process.env.key?.trim() || '';
process.env.DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL?.trim() || 'deepseek-flash';

if (!process.env.DEEPSEEK_API_KEY) {
  console.error('Missing DEEPSEEK_API_KEY. Set it in the environment or .env (key is also accepted).');
  process.exit(1);
}

function run(script, args) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: root, env: process.env, stdio: 'inherit', windowsHide: true
  });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log(`DeepSeek live extension tests: ${process.env.DEEPSEEK_MODEL} at https://api.deepseek.com`);
run(fileURLToPath(new URL('../build.mjs', import.meta.url)), ['--release']);
run(fileURLToPath(new URL('../node_modules/@playwright/test/cli.js', import.meta.url)), [
  'test', '--config=playwright.deepseek.config.ts', ...process.argv.slice(2)
]);
