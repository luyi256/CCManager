import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import type { DockerConfig } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Verify Docker daemon is available and running.
 */
export async function verifyDockerAvailable(): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('docker', ['info'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    proc.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error('Docker is not available. Please install Docker and ensure the daemon is running.'));
    });
    proc.on('error', () => {
      reject(new Error('Docker command not found. Please install Docker.'));
    });
  });
}

/**
 * Ensure the Docker image exists. If not, try to pull it, then fall back to building from local Dockerfile.
 */
export async function ensureDockerImage(config: DockerConfig): Promise<void> {
  const imageName = config.image;

  // Step 1: Check if image already exists
  const exists = await imageExists(imageName);
  if (exists) {
    console.log(`Docker image '${imageName}' already exists.`);
    return;
  }

  // Step 2: Try to pull from registry
  console.log(`Docker image '${imageName}' not found. Attempting to pull...`);
  const pulled = await pullImage(imageName);
  if (pulled) {
    console.log(`Successfully pulled '${imageName}'.`);
    return;
  }

  // Step 3: Build from local Dockerfile
  console.log(`Pull failed. Building '${imageName}' from local Dockerfile...`);
  const dockerfileDir = path.resolve(__dirname, '..', 'docker');
  await buildImage(imageName, dockerfileDir);
  console.log(`Successfully built '${imageName}'.`);
}

async function imageExists(imageName: string): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn('docker', ['image', 'inspect', imageName], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    proc.on('exit', (code) => resolve(code === 0));
    proc.on('error', () => resolve(false));
  });
}

async function pullImage(imageName: string): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn('docker', ['pull', imageName], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    proc.stdout?.on('data', (d: Buffer) => process.stdout.write(d));
    proc.stderr?.on('data', (d: Buffer) => process.stderr.write(d));
    proc.on('exit', (code) => resolve(code === 0));
    proc.on('error', () => resolve(false));
  });
}

async function buildImage(imageName: string, contextPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('docker', ['build', '-t', imageName, contextPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    proc.stdout?.on('data', (d: Buffer) => process.stdout.write(d));
    proc.stderr?.on('data', (d: Buffer) => process.stderr.write(d));
    proc.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Docker build failed with exit code ${code}`));
    });
    proc.on('error', reject);
  });
}
