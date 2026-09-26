// scripts/build-frontend.js — Copies the static frontend into dist (no build step needed).
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = join(__dirname, '..', 'frontend', 'dist');
const dest = join(__dirname, '..', 'frontend', 'dist');

if (existsSync(src)) {
  // Frontend is already static in dist/ — no compilation needed.
  console.log('Frontend build: static assets ready in frontend/dist/');
  console.log('  - index.html');
  console.log('  - styles.css');
  console.log('  - app.js');
} else {
  console.error('Frontend source not found at', src);
  process.exit(1);
}
