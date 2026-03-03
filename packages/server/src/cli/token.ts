#!/usr/bin/env node
import { parseArgs } from 'node:util';
import dotenv from 'dotenv';
import { existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// Load .env BEFORE any DB-dependent imports (same logic as index.ts)
const __cli_dir = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__cli_dir, '../../../../.env');
if (existsSync(envPath)) {
  dotenv.config({ path: envPath });
} else {
  dotenv.config();
}

const USAGE = `Usage: token <command> [options]

Commands:
  create --name <name>   Create a new device token
  list                   List all registered devices
  revoke <id>            Revoke a device token by ID

Examples:
  token create --name "MacBook Pro"
  token list
  token revoke 3
`;

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === '--help' || command === '-h') {
    console.log(USAGE);
    process.exit(0);
  }

  // Dynamic imports so dotenv runs first
  const { generateToken, hashToken } = await import('../services/auth.js');
  const { createDevice, listDevices, deleteDevice } = await import('../services/storage.js');
  const { db } = await import('../services/database.js');

  try {
    switch (command) {
      case 'create':
        cmdCreate(args.slice(1), { generateToken, hashToken, createDevice });
        break;
      case 'list':
        cmdList(listDevices);
        break;
      case 'revoke':
        cmdRevoke(args.slice(1), deleteDevice);
        break;
      default:
        console.error(`Unknown command: ${command}\n`);
        console.log(USAGE);
        process.exit(1);
    }
  } finally {
    db.close();
  }
}

function cmdCreate(
  args: string[],
  deps: {
    generateToken: () => string;
    hashToken: (t: string) => string;
    createDevice: (name: string, hash: string) => { id: number; name: string };
  }
) {
  // Filter out bare '--' separators injected by pnpm pass-through
  const filtered = args.filter((a) => a !== '--');
  const { values } = parseArgs({
    args: filtered,
    options: {
      name: { type: 'string', short: 'n' },
    },
  });

  const name = values.name;
  if (!name || name.trim().length === 0) {
    console.error('Error: --name is required\n');
    console.log('Usage: token create --name "MacBook Pro"');
    process.exit(1);
  }

  if (name.trim().length > 64) {
    console.error('Error: name too long (max 64 characters)');
    process.exit(1);
  }

  const token = deps.generateToken();
  const tokenHash = deps.hashToken(token);
  const device = deps.createDevice(name.trim(), tokenHash);

  console.log('');
  console.log('Device token created successfully!');
  console.log('');
  console.log(`  Device ID:   ${device.id}`);
  console.log(`  Device Name: ${device.name}`);
  console.log(`  Token:       ${token}`);
  console.log('');
  console.log('This token will only be shown once. Copy it now and paste it into the browser login page.');
  console.log('');
}

function cmdList(listDevices: () => Array<{ id: number; name: string; createdAt: string; lastUsedAt: string | null }>) {
  const devices = listDevices();

  if (devices.length === 0) {
    console.log('No registered devices.');
    return;
  }

  console.log('');
  console.log('Registered devices:');
  console.log('');

  // Table header
  const header = ['ID', 'Name', 'Created', 'Last Used'];
  const rows = devices.map((d) => [
    String(d.id),
    d.name,
    d.createdAt,
    d.lastUsedAt || '-',
  ]);

  // Calculate column widths
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i].length))
  );

  const line = widths.map((w) => '-'.repeat(w)).join('--+-');
  const fmt = (row: string[]) =>
    row.map((cell, i) => cell.padEnd(widths[i])).join('  | ');

  console.log(`  ${fmt(header)}`);
  console.log(`  ${line}`);
  for (const row of rows) {
    console.log(`  ${fmt(row)}`);
  }
  console.log('');
}

function cmdRevoke(args: string[], deleteDevice: (id: number) => boolean) {
  // Filter out bare '--' separators injected by pnpm pass-through
  const filtered = args.filter((a) => a !== '--');
  const idStr = filtered[0];
  if (!idStr) {
    console.error('Error: device ID is required\n');
    console.log('Usage: token revoke <id>');
    console.log('Use "token list" to see device IDs.');
    process.exit(1);
  }

  const id = Number(idStr);
  if (isNaN(id)) {
    console.error(`Error: invalid device ID "${idStr}"`);
    process.exit(1);
  }

  const deleted = deleteDevice(id);
  if (!deleted) {
    console.error(`Error: device with ID ${id} not found`);
    process.exit(1);
  }

  console.log(`Device ${id} revoked successfully.`);
}

main();
