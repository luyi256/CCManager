#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
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
        managerUrl: 'http://localhost:3001',
        authToken: 'your-token',
        executor: 'local',
        allowedPaths: ['/path/to/projects/*'],
      },
      null,
      2
    )
  );
  process.exit(1);
}

function validateConfig(config: AgentConfig): void {
  const required = ['agentId', 'agentName', 'managerUrl', 'authToken', 'executor', 'allowedPaths'];
  const missing = required.filter((key) => !(key in config));

  if (missing.length > 0) {
    console.error(`Missing required config fields: ${missing.join(', ')}`);
    process.exit(1);
  }

  // Bug #23: Validate config value formats
  // Validate agentId format (alphanumeric, hyphens, underscores only)
  if (!/^[a-zA-Z0-9_-]+$/.test(config.agentId)) {
    console.error('Invalid agentId format: must be alphanumeric with hyphens and underscores only');
    process.exit(1);
  }

  // Validate managerUrl format
  try {
    new URL(config.managerUrl);
  } catch {
    console.error(`Invalid managerUrl format: ${config.managerUrl}`);
    process.exit(1);
  }

  // Validate executor value
  if (config.executor !== 'local' && config.executor !== 'docker') {
    console.error(`Invalid executor: ${config.executor}. Must be 'local' or 'docker'`);
    process.exit(1);
  }

  if (config.executor === 'docker' && !config.dockerConfig) {
    console.error('Docker executor requires dockerConfig');
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

  console.log(`Agent ID: ${config.agentId}`);
  console.log(`Agent Name: ${config.agentName}`);
  console.log(`Executor: ${config.executor}`);
  console.log(`Allowed Paths: ${config.allowedPaths.join(', ')}`);

  // Docker setup: verify Docker availability and ensure image exists
  if (config.executor === 'docker' && config.dockerConfig) {
    const { verifyDockerAvailable, ensureDockerImage } = await import('./dockerSetup.js');

    console.log('Docker executor mode — verifying Docker availability...');
    await verifyDockerAvailable();

    console.log('Ensuring Docker image is available...');
    await ensureDockerImage(config.dockerConfig);

    console.log('Docker setup complete.');
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
