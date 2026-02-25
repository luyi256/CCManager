export function generateClaudeMd(worktreePath: string, taskId: number): string {
  return `# CCManager Work Directory Rules

## Current Task
- Task ID: ${taskId}
- Work Directory: ${worktreePath}

## Strict Limitations

**You can only modify files within the current directory.**

### Prohibited Operations

1. Do not access or modify other worktrees (\`../.worktrees/task-xxx/\`)
2. Do not modify main branch files (\`../src/\`, \`../package.json\`, etc.)
3. Do not modify system configuration files (\`~/.bashrc\`, \`~/.gitconfig\`, etc.)
4. Do not install global packages (\`npm install -g\`, \`pip install\` without \`--user\`)
5. Do not access sensitive directories like \`~/.ssh\`, \`~/.aws\`
6. Do not use absolute paths to write outside the current directory

### Waiting for Operations

If you need to wait for an operation to complete (downloads, compilation, tests), use the following format:

\`\`\`
[WAITING]
reason: Description of what you're waiting for
check_after: Expected wait time (e.g., "5m", "10m", "1h")
check_command: Optional command to check if complete (e.g., "test -f node_modules/.package-lock.json")
[/WAITING]
\`\`\`

### If Exception Needed

If the task genuinely requires one of the prohibited operations:
1. Clearly explain why
2. Use [PERMISSION_REQUEST] marker to request permission
3. Wait for user confirmation before proceeding

Example:
\`\`\`
[PERMISSION_REQUEST]
operation: Install global CLI tool
reason: Project requires TypeScript compiler
command: npm install -g typescript
[/PERMISSION_REQUEST]
\`\`\`
`;
}
