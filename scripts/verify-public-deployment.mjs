#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const cliArgs = process.argv.slice(2).filter((argument) => argument !== '--');
const baseUrl = (cliArgs[0] || process.env.CCM_PUBLIC_URL || '').replace(/\/?$/, '/');
if (!baseUrl) throw new Error('Usage: node scripts/verify-public-deployment.mjs https://host/ccm/');

const headers = { 'cache-control': 'no-cache', pragma: 'no-cache' };
const response = await fetch(baseUrl, { headers });
if (!response.ok) throw new Error(`Public index returned HTTP ${response.status}`);
const remoteIndex = await response.text();
const scriptMatch = remoteIndex.match(/src="([^"]+\/assets\/[^"]+\.js)"/);
if (!scriptMatch) throw new Error('Public index does not reference the production JS bundle');

const remoteScriptUrl = new URL(scriptMatch[1], baseUrl);
const scriptResponse = await fetch(remoteScriptUrl, { headers });
if (!scriptResponse.ok) throw new Error(`Public JS returned HTTP ${scriptResponse.status}`);
const remoteBundle = Buffer.from(await scriptResponse.arrayBuffer());

const localIndex = fs.readFileSync(path.join(root, 'packages/web/dist/index.html'), 'utf8');
const localMatch = localIndex.match(/src="([^"]+\/assets\/[^"]+\.js)"/);
if (!localMatch) throw new Error('Local build does not reference the production JS bundle');
const localBundle = fs.readFileSync(path.join(root, 'packages/web/dist', localMatch[1].replace(/^\/ccm\//, '')));

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

const localHash = sha256(localBundle);
const remoteHash = sha256(remoteBundle);
if (localHash !== remoteHash) {
  throw new Error(
    `Public deployment is stale. local=${path.basename(localMatch[1])}:${localHash}, ` +
    `remote=${path.basename(remoteScriptUrl.pathname)}:${remoteHash}`,
  );
}
if (!remoteBundle.includes(Buffer.from('Cursor')) || !remoteBundle.includes(Buffer.from('cursor'))) {
  throw new Error('Public bundle does not contain Cursor runner markers');
}

console.log(`Public deployment OK: ${remoteScriptUrl} sha256=${remoteHash}`);
