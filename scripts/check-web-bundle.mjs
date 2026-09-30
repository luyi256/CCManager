#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const dist = path.join(root, 'packages/web/dist');
const indexPath = path.join(dist, 'index.html');

if (!fs.existsSync(indexPath)) {
  throw new Error('packages/web/dist/index.html is missing; run pnpm run build first');
}

const index = fs.readFileSync(indexPath, 'utf8');
const scripts = Array.from(index.matchAll(/src="\/ccm\/([^"]+\.js)"/g), (match) => match[1]);
if (scripts.length === 0) throw new Error('Built index does not reference a JavaScript bundle');

const bundle = scripts.map((file) => fs.readFileSync(path.join(dist, file), 'utf8')).join('\n');
const markers = [
  { label: 'Cursor runner id', pattern: /id:"cursor"/ },
  { label: 'Cursor runner label', pattern: /label:"Cursor"/ },
  { label: 'tCodex runner id', pattern: /id:"tcodex"/ },
  { label: 'Claude runner id', pattern: /id:"claude"/ },
  { label: 'reasoning effort selector', pattern: /Reasoning effort/ },
];

for (const marker of markers) {
  if (!marker.pattern.test(bundle)) throw new Error(`Production bundle is missing ${marker.label}`);
}

console.log(`Web bundle OK: ${scripts.join(', ')}`);
