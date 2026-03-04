#!/usr/bin/env node
import dotenv from 'dotenv';
import { existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// Load .env BEFORE any DB-dependent imports
const __cli_dir = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__cli_dir, '../../../../.env');
if (existsSync(envPath)) {
  dotenv.config({ path: envPath });
} else {
  dotenv.config();
}

import { runTokenCommand } from './token.js';

const USAGE = `Usage: ccmng <command> [subcommand] [options]

Commands:
  token create --name <name>   Create a new device token
  token list                   List all registered devices
  token revoke <id>            Revoke a device token by ID

Examples:
  ccmng token create --name "MacBook Pro"
  ccmng token list
  ccmng token revoke 3
`;

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === '--help' || command === '-h') {
    console.log(USAGE);
    process.exit(0);
  }

  switch (command) {
    case 'token':
      await runTokenCommand(args.slice(1));
      break;
    default:
      console.error(`Unknown command: ${command}\n`);
      console.log(USAGE);
      process.exit(1);
  }
}

main();
