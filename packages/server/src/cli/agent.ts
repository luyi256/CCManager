import { parseArgs } from 'node:util';

const USAGE = `Usage: ccmng agent <subcommand> [options]

Subcommands:
  create --id <id> [--name <name>]   Register agent and generate token
  list                                List all registered agents
  token <id>                          Regenerate token for an agent
  revoke <id>                         Revoke an agent's token
`;

export async function runAgentCommand(args: string[]) {
  const subcommand = args[0];

  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    console.log(USAGE);
    process.exit(0);
  }

  const { generateToken, hashToken } = await import('../services/auth.js');
  const { createAgentToken, getAgentTokenInfo, deleteAgentToken } = await import('../services/storage.js');
  const { db } = await import('../services/database.js');

  try {
    switch (subcommand) {
      case 'create':
        cmdCreate(args.slice(1), { generateToken, hashToken, createAgentToken, db });
        break;
      case 'list':
        cmdList(db);
        break;
      case 'token':
        cmdToken(args.slice(1), { generateToken, hashToken, createAgentToken, getAgentTokenInfo, db });
        break;
      case 'revoke':
        cmdRevoke(args.slice(1), { deleteAgentToken, db });
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
    createAgentToken: (agentId: string, hash: string) => { id: number };
    db: import('better-sqlite3').Database;
  }
) {
  const { values } = parseArgs({
    args,
    options: {
      id: { type: 'string' },
      name: { type: 'string', short: 'n' },
    },
    allowPositionals: true,
  });

  const agentId = values.id;
  if (!agentId || agentId.trim().length === 0) {
    console.error('Error: --id is required\n');
    console.log('Usage: ccmng agent create --id my-agent --name "My Agent"');
    process.exit(1);
  }

  if (!/^[a-zA-Z0-9_-]+$/.test(agentId)) {
    console.error('Error: agent ID must be alphanumeric with hyphens and underscores only');
    process.exit(1);
  }

  const name = values.name?.trim() || agentId;

  // Upsert agent record
  deps.db.prepare(`
    INSERT INTO agents (id, name, capabilities, executor, status)
    VALUES (?, ?, '[]', 'local', 'offline')
    ON CONFLICT(id) DO UPDATE SET name = excluded.name
  `).run(agentId, name);

  // Generate token
  const token = deps.generateToken();
  const tokenHash = deps.hashToken(token);
  deps.createAgentToken(agentId, tokenHash);

  console.log('');
  console.log('Agent registered and token created!');
  console.log('');
  console.log(`  Agent ID:   ${agentId}`);
  console.log(`  Name:       ${name}`);
  console.log(`  Token:      ${token}`);
  console.log('');
  console.log('This token will only be shown once.');
  console.log('Paste it when the agent prompts "Enter agent token:" on first run.');
  console.log('');
}

function cmdList(db: import('better-sqlite3').Database) {
  const rows = db.prepare(`
    SELECT a.id, a.name, a.status,
           at.created_at as token_created,
           at.last_used_at as token_last_used
    FROM agents a
    LEFT JOIN agent_tokens at ON a.id = at.agent_id
    ORDER BY a.id
  `).all() as Array<{
    id: string;
    name: string;
    status: string;
    token_created: string | null;
    token_last_used: string | null;
  }>;

  if (rows.length === 0) {
    console.log('No registered agents.');
    return;
  }

  console.log('');
  console.log('Registered agents:');
  console.log('');

  const header = ['ID', 'Name', 'Status', 'Token Created', 'Token Last Used'];
  const data = rows.map((r) => [
    r.id,
    r.name,
    r.status,
    r.token_created || '(no token)',
    r.token_last_used || '-',
  ]);

  const widths = header.map((h, i) =>
    Math.max(h.length, ...data.map((r) => r[i].length))
  );

  const line = widths.map((w) => '-'.repeat(w)).join('--+-');
  const fmt = (row: string[]) =>
    row.map((cell, i) => cell.padEnd(widths[i])).join('  | ');

  console.log(`  ${fmt(header)}`);
  console.log(`  ${line}`);
  for (const row of data) {
    console.log(`  ${fmt(row)}`);
  }
  console.log('');
}

function cmdToken(
  args: string[],
  deps: {
    generateToken: () => string;
    hashToken: (t: string) => string;
    createAgentToken: (agentId: string, hash: string) => { id: number };
    getAgentTokenInfo: (agentId: string) => { hasToken: boolean };
    db: import('better-sqlite3').Database;
  }
) {
  const agentId = args[0];
  if (!agentId) {
    console.error('Error: agent ID is required\n');
    console.log('Usage: ccmng agent token <agent-id>');
    process.exit(1);
  }

  // Verify agent exists
  const agent = deps.db.prepare('SELECT id, name FROM agents WHERE id = ?').get(agentId) as { id: string; name: string } | undefined;
  if (!agent) {
    console.error(`Error: agent "${agentId}" not found`);
    console.error('Use "ccmng agent list" to see registered agents.');
    process.exit(1);
  }

  const token = deps.generateToken();
  const tokenHash = deps.hashToken(token);
  deps.createAgentToken(agentId, tokenHash);

  console.log('');
  console.log(`Token regenerated for agent "${agent.name}" (${agentId})`);
  console.log('');
  console.log(`  Token: ${token}`);
  console.log('');
  console.log('This token will only be shown once. The old token is now invalid.');
  console.log('');
}

function cmdRevoke(
  args: string[],
  deps: {
    deleteAgentToken: (agentId: string) => boolean;
    db: import('better-sqlite3').Database;
  }
) {
  const agentId = args[0];
  if (!agentId) {
    console.error('Error: agent ID is required\n');
    console.log('Usage: ccmng agent revoke <agent-id>');
    process.exit(1);
  }

  const deleted = deps.deleteAgentToken(agentId);
  if (!deleted) {
    console.error(`Error: no token found for agent "${agentId}"`);
    console.error('Use "ccmng agent list" to see registered agents.');
    process.exit(1);
  }

  console.log(`Token revoked for agent "${agentId}".`);
}
