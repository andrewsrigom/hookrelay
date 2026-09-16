import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { ConflictError } from '../packages/core/model.js';
import { SqliteStore } from '../packages/storage/sqlite-store.js';

it('rolls back all records when any transaction condition fails', async () => {
  const store = new SqliteStore(':memory:');
  try {
    const value = { id: 'one', version: 1, createdAt: 1 };
    await store.transact([{ kind: 'T', value, expectedVersion: 'absent' }]);
    await expect(
      store.transact([
        { kind: 'T', value: { ...value, id: 'two' }, expectedVersion: 'absent' },
        { kind: 'T', value, expectedVersion: 'absent' },
      ]),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(await store.get('T', 'two')).toBeUndefined();
  } finally {
    store.close();
  }
});

it('preserves state and queue work across process restarts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hookrelay-durable-'));
  const path = join(directory, 'state.sqlite');
  let store = new SqliteStore(path);

  try {
    await store.transact([
      {
        kind: 'OUTBOX',
        value: {
          id: 'job',
          version: 1,
          createdAt: 1,
          deliveryId: 'dlv_1',
          expectedAttempt: 1,
          route: 'delivery',
          availableAt: 0,
        } as import('../packages/core/model.js').Job,
        expectedVersion: 'absent',
      },
    ]);
    const first = (await store.claimJobs(100))[0]!;
    store.close();
    store = new SqliteStore(path);
    expect(await store.claimJobs(200)).toHaveLength(0);
    const recovered = (await store.claimJobs(40000))[0]!;
    expect(recovered.id).toBe(first.id);
    await expect(store.acknowledge(first)).rejects.toBeInstanceOf(ConflictError);
    await store.acknowledge(recovered);
    expect(await store.claimJobs(80000)).toHaveLength(0);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
