import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { diskSchema } from './schema';
export type DiskState = z.infer<typeof diskSchema>;
export class Store {
  value: DiskState = diskSchema.parse({});
  recovery: string[] = [];
  private db?: DatabaseSync;
  private revision = 0;
  private queue = Promise.resolve();
  constructor(readonly directory: string) {}
  async load() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const filename = path.join(this.directory, 'forge.sqlite');
    this.db = new DatabaseSync(filename);
    await fs.chmod(filename, 0o600);
    this.db.exec(
      'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS journal (seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, kind TEXT NOT NULL, json TEXT NOT NULL, time INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS state_history (revision INTEGER PRIMARY KEY, json TEXT NOT NULL);',
    );
    const row = this.db.prepare('SELECT revision,json FROM state WHERE id=1').get() as
      { revision: number; json: string } | undefined;
    if (row) {
      this.revision = row.revision;
      try {
        this.value = diskSchema.parse(JSON.parse(row.json));
      } catch {
        this.journal('invalid-state-preserved', { json: row.json });
        let recovered = false;
        for (const item of this.db
          .prepare('SELECT json FROM state_history ORDER BY revision DESC')
          .all() as { json: string }[]) {
          try {
            this.value = diskSchema.parse(JSON.parse(item.json));
            recovered = true;
            break;
          } catch {}
        }
        if (!recovered) this.value = diskSchema.parse({});
        this.recovery.push(
          recovered
            ? 'Invalid state was preserved in the journal. Restored the last validated snapshot.'
            : 'Invalid state was preserved in the journal. Started with defaults.',
        );
        await this.save();
      }
      return;
    }
    const legacy = path.join(this.directory, 'state.json');
    try {
      const raw = await fs.readFile(legacy, 'utf8');
      await fs.copyFile(legacy, path.join(this.directory, `state-legacy-${Date.now()}.json`));
      try {
        this.value = diskSchema.parse(JSON.parse(raw));
        this.recovery.push('Previous JSON data was backed up and migrated to SQLite.');
      } catch {
        let parsed: Record<string, unknown> = {};
        try {
          parsed = JSON.parse(raw);
        } catch {}
        const recovered: Record<string, unknown> = {};
        for (const [key, schema] of Object.entries(diskSchema.shape)) {
          const result = schema.safeParse(parsed?.[key]);
          if (result.success) recovered[key] = result.data;
        }
        this.value = diskSchema.parse(recovered);
        this.recovery.push(
          'Damaged legacy data was preserved as state-legacy-*.json. Valid sections were recovered; invalid sections use defaults.',
        );
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    await this.save();
  }
  save() {
    const snapshot = JSON.stringify(diskSchema.parse(this.value));
    const operation = this.queue
      .catch(() => {})
      .then(() => {
        const db = this.db!;
        db.exec('BEGIN IMMEDIATE');
        try {
          const row = db.prepare('SELECT revision FROM state WHERE id=1').get() as
            { revision: number } | undefined;
          if ((row?.revision ?? 0) !== this.revision)
            throw new Error(
              'Another writer changed this database. Restart Forge to reload safely. No data was overwritten.',
            );
          db.prepare(
            'INSERT OR IGNORE INTO state_history(revision,json) SELECT revision,json FROM state WHERE id=1',
          ).run();
          db.exec(
            'DELETE FROM state_history WHERE revision NOT IN (SELECT revision FROM state_history ORDER BY revision DESC LIMIT 3)',
          );
          db.prepare(
            'INSERT INTO state(id,revision,json) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,json=excluded.json',
          ).run(this.revision + 1, snapshot);
          db.exec('COMMIT');
          this.revision++;
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      });
    this.queue = operation;
    return operation;
  }
  journal(kind: string, data: unknown, runId?: string) {
    this.db!.prepare('INSERT INTO journal(run_id,kind,json,time) VALUES(?,?,?,?)').run(
      runId ?? null,
      kind,
      JSON.stringify(data),
      Date.now(),
    );
  }
  cached<T>(key: string): T | undefined {
    const row = this.db!.prepare('SELECT json FROM cache WHERE key=?').get(key) as
      { json: string } | undefined;
    return row ? JSON.parse(row.json) : undefined;
  }
  cache(key: string, data: unknown) {
    this.db!.prepare(
      'INSERT INTO cache(key,json) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET json=excluded.json',
    ).run(key, JSON.stringify(data));
  }
  async backup() {
    await this.flush();
    const destination = path.join(this.directory, `backup-${randomUUID()}.sqlite`);
    this.db!.exec(`VACUUM INTO '${destination.replaceAll("'", "''")}'`);
    await fs.chmod(destination, 0o600);
    return destination;
  }
  async flush() {
    await this.queue;
  }
  async close() {
    await this.flush();
    this.db?.close();
  }
}
