import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';

const execAsync = promisify(exec);

export interface MergeResult {
  success: boolean;
  mergeCommit?: string;
  conflicts?: string[];
  error?: string;
}

export class WorktreeManager {
  private async git(projectPath: string, args: string): Promise<string> {
    const { stdout } = await execAsync(`git -C ${JSON.stringify(projectPath)} ${args}`, {
      timeout: 30000,
    });
    return stdout.trim();
  }

  /**
   * Create a worktree for the given branch.
   * Returns the absolute path to the worktree directory.
   */
  async create(projectPath: string, branch: string): Promise<string> {
    const worktreeDir = path.join(projectPath, '.worktrees');
    if (!fs.existsSync(worktreeDir)) {
      fs.mkdirSync(worktreeDir, { recursive: true });
    }

    const worktreePath = path.join(worktreeDir, branch);

    // If worktree already exists, return it
    if (fs.existsSync(worktreePath)) {
      console.log(`Worktree already exists: ${worktreePath}`);
      return worktreePath;
    }

    await this.git(projectPath, `worktree add -b ${branch} ${JSON.stringify(worktreePath)} HEAD`);
    console.log(`Created worktree: ${worktreePath} (branch: ${branch})`);
    return worktreePath;
  }

  /**
   * Merge the worktree branch back into the current branch.
   */
  async merge(projectPath: string, branch: string, deleteBranch: boolean): Promise<MergeResult> {
    try {
      // Check if the branch has any commits beyond the base
      let hasCommits = false;
      try {
        const log = await this.git(projectPath, `log ${branch} --not HEAD --oneline`);
        hasCommits = log.length > 0;
      } catch {
        // If the command fails, assume no commits
      }

      if (!hasCommits) {
        // Clean up even if no commits
        await this.cleanup(projectPath, branch);
        if (deleteBranch) {
          await this.deleteBranch(projectPath, branch);
        }
        return { success: true };
      }

      // Merge the branch with --no-ff
      try {
        await this.git(projectPath, `merge ${branch} --no-ff -m "Merge ${branch}"`);
      } catch (mergeError) {
        // Check for merge conflicts
        try {
          const status = await this.git(projectPath, 'diff --name-only --diff-filter=U');
          if (status) {
            // Abort the merge
            await this.git(projectPath, 'merge --abort');
            return {
              success: false,
              conflicts: status.split('\n').filter(Boolean),
            };
          }
        } catch {
          // ignore
        }
        throw mergeError;
      }

      // Get the merge commit hash
      const mergeCommit = await this.git(projectPath, 'rev-parse HEAD');

      // Clean up worktree
      await this.cleanup(projectPath, branch);
      if (deleteBranch) {
        await this.deleteBranch(projectPath, branch);
      }

      return { success: true, mergeCommit };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  }

  /**
   * Remove the worktree directory (does not delete the branch).
   */
  async cleanup(projectPath: string, branch: string): Promise<void> {
    try {
      await this.git(projectPath, `worktree remove ${JSON.stringify(path.join('.worktrees', branch))} --force`);
      console.log(`Removed worktree for branch: ${branch}`);
    } catch (error) {
      // Worktree may already be removed
      console.warn(`Failed to remove worktree for ${branch}:`, error instanceof Error ? error.message : error);
    }
  }

  /**
   * Delete the branch.
   */
  async deleteBranch(projectPath: string, branch: string): Promise<void> {
    try {
      await this.git(projectPath, `branch -D ${branch}`);
      console.log(`Deleted branch: ${branch}`);
    } catch (error) {
      console.warn(`Failed to delete branch ${branch}:`, error instanceof Error ? error.message : error);
    }
  }
}
