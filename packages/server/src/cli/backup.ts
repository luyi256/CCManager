import { readdirSync, unlinkSync, mkdirSync, existsSync } from 'fs';
import { join, resolve } from 'path';

const DEFAULT_KEEP = 7;

export async function runBackupCommand(args: string[]) {
  if (args[0] === '--help' || args[0] === '-h') {
    console.log(`Usage: ccmng backup [--keep <n>]

Creates a timestamped SQLite backup using the .backup() API (hot, no locking).
Backups are stored in <DATA_PATH>/backups/. Old backups beyond --keep (default ${DEFAULT_KEEP}) are removed.
`);
    process.exit(0);
  }

  // Parse --keep
  let keep = DEFAULT_KEEP;
  const keepIdx = args.indexOf('--keep');
  if (keepIdx !== -1 && args[keepIdx + 1]) {
    keep = parseInt(args[keepIdx + 1], 10);
    if (isNaN(keep) || keep < 1) {
      console.error('Error: --keep must be a positive integer');
      process.exit(1);
    }
  }

  const { db } = await import('../services/database.js');

  const dataPath = process.env.DATA_PATH || resolve(process.cwd(), 'data');
  const backupDir = join(dataPath, 'backups');

  if (!existsSync(backupDir)) {
    mkdirSync(backupDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backupFile = join(backupDir, `ccmanager-${timestamp}.db`);

  console.log(`Backing up database to: ${backupFile}`);

  try {
    await db.backup(backupFile);
    console.log('Backup completed successfully.');
  } catch (e) {
    console.error('Backup failed:', e instanceof Error ? e.message : e);
    db.close();
    process.exit(1);
  }

  // Rotate: remove old backups beyond keep count
  const backups = readdirSync(backupDir)
    .filter((f) => f.startsWith('ccmanager-') && f.endsWith('.db'))
    .sort()
    .reverse(); // newest first

  if (backups.length > keep) {
    const toRemove = backups.slice(keep);
    for (const f of toRemove) {
      const fp = join(backupDir, f);
      unlinkSync(fp);
      console.log(`Removed old backup: ${f}`);
    }
  }

  console.log(`Kept ${Math.min(backups.length, keep)} backup(s).`);
  db.close();
}
