import { parseArgs } from 'node:util';

const USAGE = `Usage: ccmng token <subcommand> [options]

Subcommands:
  create --name <name>   Create a new device token
  list                   List all registered devices
  revoke <id>            Revoke a device token by ID
`;

export async function runTokenCommand(args: string[]) {
  const subcommand = args[0];

  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    console.log(USAGE);
    process.exit(0);
  }

  // Dynamic imports — env must be loaded first (done by cli/index.ts)
  const { generateToken, hashToken } = await import('../services/auth.js');
  const { createDevice, listDevices, deleteDevice } = await import('../services/storage.js');
  const { db } = await import('../services/database.js');

  try {
    switch (subcommand) {
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
        console.error(`Unknown subcommand: ${subcommand}\n`);
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
  const { values } = parseArgs({
    args,
    options: {
      name: { type: 'string', short: 'n' },
    },
    allowPositionals: true,
  });

  const name = values.name;
  if (!name || name.trim().length === 0) {
    console.error('Error: --name is required\n');
    console.log('Usage: ccmng token create --name "MacBook Pro"');
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

  const header = ['ID', 'Name', 'Created', 'Last Used'];
  const rows = devices.map((d) => [
    String(d.id),
    d.name,
    d.createdAt,
    d.lastUsedAt || '-',
  ]);

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
  const idStr = args[0];
  if (!idStr) {
    console.error('Error: device ID is required\n');
    console.log('Usage: ccmng token revoke <id>');
    console.log('Use "ccmng token list" to see device IDs.');
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
