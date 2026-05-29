import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptsDir, '..');
const sourceDir = path.join(rootDir, 'website');
const outputDir = path.join(rootDir, 'website-dist');

async function copyFile(srcPath, destPath) {
  await fs.mkdir(path.dirname(destPath), { recursive: true });
  await fs.copyFile(srcPath, destPath);
}

async function copyDir(srcDir, destDir) {
  const entries = await fs.readdir(srcDir, { withFileTypes: true });
  await fs.mkdir(destDir, { recursive: true });

  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath);
    } else if (entry.isFile()) {
      await copyFile(srcPath, destPath);
    }
  }
}

async function main() {
  await fs.rm(outputDir, { recursive: true, force: true });
  await copyDir(sourceDir, outputDir);
  await copyDir(path.join(rootDir, '_locales'), path.join(outputDir, '_locales'));
  await copyFile(path.join(rootDir, 'i18n.js'), path.join(outputDir, 'i18n.js'));
  console.log('Website prepared in website-dist/.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
