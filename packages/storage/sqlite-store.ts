import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import {
  ConflictError,
  kinds,
  type Job,
  type Mutation,
  type RecordBase,
  type Store,
} from '../core/model.js';

/** Local state and jobs share one SQLite file. */
export class SqliteStore implements Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path, { timeout: 5000 });
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS records (
        kind TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL,
        created_at INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY(kind, id)
      );
      CREATE INDEX IF NOT EXISTS records_by_time ON records(kind, created_at DESC, id DESC);`);
  }

  async get<T extends RecordBase>(kind: string, id: string): Promise<T | undefined> {
    const row = this.db.prepare('SELECT value FROM records WHERE kind=? AND id=?').get(kind, id);
    return row ? (JSON.parse(String(row['value'])) as T) : undefined;
  }

  async list<T extends RecordBase>(kind: string, limit = 200): Promise<T[]> {
    return this.db
      .prepare('SELECT value FROM records WHERE kind=? ORDER BY created_at DESC, id DESC LIMIT ?')
      .all(kind, limit)
      .map((row) => JSON.parse(String(row['value'])) as T);
  }

  async transact(changes: Mutation[]): Promise<void> {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const change of changes) {
        const row = this.db
          .prepare('SELECT version FROM records WHERE kind=? AND id=?')
          .get(change.kind, change.value.id);
        if (
          change.expectedVersion === 'absent'
            ? Boolean(row)
            : row?.['version'] !== change.expectedVersion
        ) {
          throw new ConflictError();
        }
        this.db
          .prepare(
            `INSERT INTO records(kind,id,version,created_at,value) VALUES(?,?,?,?,?)
          ON CONFLICT(kind,id) DO UPDATE SET version=excluded.version,value=excluded.value`,
          )
          .run(
            change.kind,
            change.value.id,
            change.value.version,
            change.value.createdAt,
            JSON.stringify(change.value),
          );
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  async claimJobs(now: number, limit = 4): Promise<Job[]> {
    const candidates = this.db
      .prepare(
        `SELECT value FROM records WHERE kind=?
      AND json_extract(value,'$.route')='delivery' AND json_extract(value,'$.availableAt') <= ?
      AND COALESCE(json_extract(value,'$.acknowledged'),0)=0
      AND COALESCE(json_extract(value,'$.queueLeaseUntil'),0) <= ?
      ORDER BY created_at ASC LIMIT ?`,
      )
      .all(kinds.job, now, now, limit);
    const claimed: Job[] = [];

    for (const row of candidates) {
      const job = JSON.parse(String(row['value'])) as Job;
      const updated = {
        ...job,
        version: job.version + 1,
        queueLeaseUntil: now + 35000,
        queueLeaseToken: randomUUID(),
      };
      try {
        await this.transact([{ kind: kinds.job, value: updated, expectedVersion: job.version }]);
        claimed.push(updated);
      } catch (error) {
        if (!(error instanceof ConflictError)) {
          throw error;
        }
      }
    }

    return claimed;
  }

  async acknowledge(job: Job) {
    await this.transact([
      {
        kind: kinds.job,
        value: { ...job, version: job.version + 1, acknowledged: true } as Job,
        expectedVersion: job.version,
      },
    ]);
  }

  close() {
    this.db.close();
  }
}
