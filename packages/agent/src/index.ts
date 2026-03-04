#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { AgentConnection } from './connection.js';
import type { AgentConfig } from './types.js';

const CONFIG_PATH = path.join(process.env.HOME || '', '.ccm-agent.json');

function loadConfig(): AgentConfig {
  // Check command line argument
  const configArg = process.argv.find((arg) => arg.startsWith('--config='));
  if (configArg) {
    const configPath = configArg.split('=')[1];
    return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  }

  // Check default path
  const fullPath = path.resolve(CONFIG_PATH);
  if (fs.existsSync(fullPath)) {
    console.log(`Loading config from: ${fullPath}`);
    return JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
  }

  console.error(`No config file found at: ${fullPath}`);
  console.error('\nCreate a config file with:');
  console.error(
    JSON.stringify(
      {
        agentId: 'my-agent',
        agentName: 'My Agent',
        dataPath: '/path/to/CCManagerData',
        allowedPaths: ['/path/to/projects/*'],
      },
      null,
      2
    )
  );
  process.exit(1);
}

function getConfigPath(): string {
  const configArg = process.argv.find((arg) => arg.startsWith('--config='));
  if (configArg) return path.resolve(configArg.split('=')[1]);
  return path.resolve(CONFIG_PATH);
}

function promptInput(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function saveTokenToConfig(configPath: string, token: string): void {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    raw.authToken = token;
    fs.writeFileSync(configPath, JSON.stringify(raw, null, 2) + '\n');
    console.log(`Token saved to ${configPath}`);
  } catch (e) {
    console.warn(`Failed to save token to config: ${e instanceof Error ? e.message : e}`);
  }
}

/** Read server URL from dataPath/server-url.txt (local file or remote URL).
 *  For local agents (dataPath is a filesystem path): try localhost first,
 *  then fall back to server-url.txt (which contains the tunnel URL). */
async function resolveServerUrl(dataPath: string): Promise<string> {
  // Remote: dataPath is a URL base (e.g. https://raw.githubusercontent.com/.../main)
  if (dataPath.startsWith('http://') || dataPath.startsWith('https://')) {
    const url = `${dataPath.replace(/\/$/, '')}/server-url.txt`;
    console.log(`Fetching server URL from: ${url}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
    return (await res.text()).trim();
  }

  // Local: dataPath is a filesystem path — try localhost first
  const localhostUrl = 'http://localhost:3001';
  try {
    const res = await fetch(`${localhostUrl}/api/health`, { signal: AbortSignal.timeout(2000) });
    if (res.ok) {
      console.log('Local server detected at localhost:3001');
      return localhostUrl;
    }
  } catch {
    // localhost not reachable, fall back to server-url.txt
  }

  // Fall back to server-url.txt (contains tunnel URL for remote access)
  const filePath = path.join(dataPath, 'server-url.txt');
  if (!fs.existsSync(filePath)) {
    throw new Error(`Local server not reachable and ${filePath} not found`);
  }
  return fs.readFileSync(filePath, 'utf-8').trim();
}

function validateConfig(config: AgentConfig): void {
  const required = ['agentId', 'agentName', 'dataPath', 'allowedPaths'];
  const missing = required.filter((key) => !(key in config));

  if (missing.length > 0) {
    console.error(`Missing required config fields: ${missing.join(', ')}`);
    process.exit(1);
  }

  // Validate agentId format (alphanumeric, hyphens, underscores only)
  if (!/^[a-zA-Z0-9_-]+$/.test(config.agentId)) {
    console.error('Invalid agentId format: must be alphanumeric with hyphens and underscores only');
    process.exit(1);
  }

  // Validate executor value if present (now optional, per-project)
  if (config.executor && config.executor !== 'local' && config.executor !== 'docker') {
    console.error(`Invalid executor: ${config.executor}. Must be 'local' or 'docker'`);
    process.exit(1);
  }

  // Validate dockerConfig if present
  if (config.dockerConfig) {
    if (!config.dockerConfig.image || typeof config.dockerConfig.image !== 'string') {
      console.error('dockerConfig.image is required and must be a string');
      process.exit(1);
    }
  }

  if (!config.allowedPaths.length) {
    console.error('At least one allowed path is required');
    process.exit(1);
  }

  // Validate allowedPaths are strings
  for (const p of config.allowedPaths) {
    if (typeof p !== 'string') {
      console.error(`Invalid allowedPaths entry: ${p}. Must be a string`);
      process.exit(1);
    }
  }

  // Validate blockedPaths if present
  if (config.blockedPaths) {
    for (const p of config.blockedPaths) {
      if (typeof p !== 'string') {
        console.error(`Invalid blockedPaths entry: ${p}. Must be a string`);
        process.exit(1);
      }
    }
  }
}

async function main(): Promise<void> {
  console.log('CC Manager Agent starting...');

  const config = loadConfig();
  validateConfig(config);

  // Prompt for auth token if not configured
  if (!config.authToken) {
    console.log('\nNo auth token found in config.');
    console.log('Generate one in Web UI → Settings → Agent Management → Register/Generate Token\n');
    const token = await promptInput('Enter agent token: ');
    if (!token) {
      console.error('Token is required to connect.');
      process.exit(1);
    }
    config.authToken = token;
    saveTokenToConfig(getConfigPath(), token);
  }

  console.log(`Agent ID: ${config.agentId}`);
  console.log(`Agent Name: ${config.agentName}`);
  console.log(`Data Path: ${config.dataPath}`);
  console.log(`Allowed Paths: ${config.allowedPaths.join(', ')}`);

  // Docker setup: verify Docker availability and ensure image exists if dockerConfig present
  if (config.dockerConfig) {
    const { verifyDockerAvailable, ensureDockerImage } = await import('./dockerSetup.js');

    console.log('Docker executor mode — verifying Docker availability...');
    await verifyDockerAvailable();

    console.log('Ensuring Docker image is available...');
    await ensureDockerImage(config.dockerConfig);

    console.log('Docker setup complete.');
  }

  // Resolve server URL from dataPath/server-url.txt
  try {
    const serverUrl = await resolveServerUrl(config.dataPath);
    new URL(serverUrl); // Validate
    config.managerUrl = serverUrl;
    console.log(`Server URL: ${serverUrl}`);
  } catch (e) {
    console.error(`Failed to resolve server URL from ${config.dataPath}: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }

  const connection = new AgentConnection(config);

  // Graceful shutdown
  const shutdown = (): void => {
    console.log('\nShutting down...');
    connection.disconnect();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Connect
  connection.connect();

  // Keep alive
  await new Promise(() => {});
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
