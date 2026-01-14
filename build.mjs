import { build, context } from 'esbuild';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const args = new Set(process.argv.slice(2));
const watch = args.has('--watch');
const release = args.has('--release');

if (watch && release) {
  console.error('Cannot use --watch and --release together.');
  process.exit(1);
}

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(rootDir, 'dist');
const releaseDir = path.join(rootDir, 'release');

const options = [
  {
    entryPoints: [path.join(rootDir, 'background.js')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
    outfile: path.join(distDir, 'background.js'),
    sourcemap: true
  },
  {
    entryPoints: [path.join(rootDir, 'chat-window.js')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    outfile: path.join(distDir, 'chat-window.js'),
    sourcemap: true
  }
];

async function buildAll() {
  for (const opt of options) {
    await build(opt);
  }
}

async function watchAll() {
  for (const opt of options) {
    const ctx = await context(opt);
    await ctx.watch();
  }
  process.on('SIGINT', () => {
    process.exit(0);
  });
}

async function ensureExists(filePath) {
  try {
    await fs.access(filePath);
  } catch {
    throw new Error(`Missing required path: ${path.relative(rootDir, filePath)}`);
  }
}

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

async function prepareRelease() {
  await fs.rm(releaseDir, { recursive: true, force: true });
  await fs.mkdir(releaseDir, { recursive: true });

  const dirsToCopy = ['icons', '_locales', 'dist'];
  const filesToCopy = [
    'manifest.json',
    'popup.html',
    'popup.js',
    'chat-window.html',
    'chat-window.css',
    'styles.css',
    'i18n.js',
    'content.js'
  ];

  for (const dir of dirsToCopy) {
    const srcDir = path.join(rootDir, dir);
    await ensureExists(srcDir);
    await copyDir(srcDir, path.join(releaseDir, dir));
  }

  for (const file of filesToCopy) {
    const srcFile = path.join(rootDir, file);
    await ensureExists(srcFile);
    await copyFile(srcFile, path.join(releaseDir, file));
  }
}

function isGlob(pattern) {
  return /[*?]/.test(pattern);
}

function collectManifestFiles(manifest) {
  const files = new Set();

  const add = (value) => {
    if (!value) return;
    if (Array.isArray(value)) {
      value.forEach(add);
      return;
    }
    if (typeof value === 'string') {
      files.add(value);
    }
  };

  add(manifest.background?.service_worker);
  add(manifest.action?.default_popup);
  add(manifest.action?.default_icon ? Object.values(manifest.action.default_icon) : []);
  add(manifest.icons ? Object.values(manifest.icons) : []);
  add(manifest.options_ui?.page);

  if (Array.isArray(manifest.content_scripts)) {
    for (const script of manifest.content_scripts) {
      add(script.js);
      add(script.css);
    }
  }

  if (Array.isArray(manifest.web_accessible_resources)) {
    for (const resource of manifest.web_accessible_resources) {
      add(resource.resources);
    }
  }

  if (manifest.default_locale) {
    add(path.join('_locales', manifest.default_locale, 'messages.json'));
  }

  return files;
}

async function validateRelease() {
  const manifestPath = path.join(releaseDir, 'manifest.json');
  await ensureExists(manifestPath);

  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error(`Invalid manifest.json in release: ${error.message}`);
  }

  const referencedFiles = collectManifestFiles(manifest);
  referencedFiles.add('popup.js');

  const missing = [];
  for (const relPath of referencedFiles) {
    if (isGlob(relPath)) {
      continue;
    }
    const fullPath = path.join(releaseDir, relPath);
    try {
      await fs.access(fullPath);
    } catch {
      missing.push(relPath);
    }
  }

  if (missing.length > 0) {
    throw new Error(`Release validation failed. Missing files:\n- ${missing.join('\n- ')}`);
  }
}

async function main() {
  if (watch) {
    await watchAll();
    return;
  }

  await buildAll();

  if (release) {
    await prepareRelease();
    await validateRelease();
    console.log('Release prepared in release/.');
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
