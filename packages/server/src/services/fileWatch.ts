const MAX_WATCHED_DIRS = 200;

/**
 * Which directories each connected user has expanded in a project's file
 * explorer. The agent watches the union per project, so its watchers follow
 * what is actually on someone's screen.
 */
export class FileWatchRegistry {
  private bySocket = new Map<string, { projectId: string; dirs: string[] }>();

  /** Returns the projects whose watch set may have changed. */
  set(socketId: string, projectId: string, dirs: string[]): string[] {
    const previous = this.bySocket.get(socketId);
    const cleaned = Array.from(new Set(dirs.filter((dir) => typeof dir === 'string'))).slice(0, MAX_WATCHED_DIRS);
    this.bySocket.set(socketId, { projectId, dirs: cleaned });
    return previous && previous.projectId !== projectId ? [previous.projectId, projectId] : [projectId];
  }

  /** Returns the project the socket was watching, if any. */
  remove(socketId: string): string | undefined {
    const previous = this.bySocket.get(socketId);
    this.bySocket.delete(socketId);
    return previous?.projectId;
  }

  dirsFor(projectId: string): string[] {
    const dirs = new Set<string>();
    for (const entry of this.bySocket.values()) {
      if (entry.projectId !== projectId) continue;
      for (const dir of entry.dirs) dirs.add(dir);
    }
    return Array.from(dirs).slice(0, MAX_WATCHED_DIRS);
  }

  subscribers(projectId: string): string[] {
    return Array.from(this.bySocket.entries())
      .filter(([, entry]) => entry.projectId === projectId)
      .map(([socketId]) => socketId);
  }

  projects(): string[] {
    return Array.from(new Set(Array.from(this.bySocket.values(), (entry) => entry.projectId)));
  }
}
