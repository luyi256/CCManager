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
import { runAgentCommand } from './agent.js';
import { runBackupCommand } from './backup.js';

const USAGE = `Usage: ccmng <command> [subcommand] [options]

Commands:
  token create --name <name>              Create a new device token
  token list                              List all registered devices
  token revoke <id>                       Revoke a device token by ID

  agent create --id <id> [--name <name>]  Register agent and generate token
  agent list                              List all registered agents
  agent token <id>                        Regenerate token for an agent
  agent revoke <id>                       Revoke an agent's token

  backup [--keep <n>]                     Backup database (default: keep 7)

Examples:
  ccmng token create --name "MacBook Pro"
  ccmng agent create --id macbook-agent --name "MacBook Agent"
  ccmng backup
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
    case 'agent':
      await runAgentCommand(args.slice(1));
      break;
    case 'backup':
      await runBackupCommand(args.slice(1));
      break;
    default:
      console.error(`Unknown command: ${command}\n`);
      console.log(USAGE);
      process.exit(1);
  }
}

main();
