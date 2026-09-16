import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { ConflictError, type Mutation, type RecordBase, type Store } from '../core/model.js';

export class DynamoStore implements Store {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  async get<T extends RecordBase>(kind: string, id: string): Promise<T | undefined> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk: kind, sk: id },
        ConsistentRead: true,
      }),
    );
    return result.Item?.['value'] as T | undefined;
  }

  async list<T extends RecordBase>(kind: string, limit = 200): Promise<T[]> {
    const values: T[] = [];
    let cursor: Record<string, unknown> | undefined;
    do {
      const page = await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          ...(kind === 'ENDPOINT' ? { ConsistentRead: true } : { IndexName: 'by-created' }),
          KeyConditionExpression: 'pk = :kind',
          ExpressionAttributeValues: { ':kind': kind },
          ScanIndexForward: false,
          Limit: limit - values.length,
          ExclusiveStartKey: cursor,
        }),
      );
      for (const row of page.Items ?? []) {
        values.push(row['value'] as T);
      }
      cursor = page.LastEvaluatedKey;
    } while (cursor && values.length < limit);

    return values;
  }

  async transact(changes: Mutation[]): Promise<void> {
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: changes.map((change) => ({
            Put: {
              TableName: this.tableName,
              Item: {
                pk: change.kind,
                sk: change.value.id,
                version: change.value.version,
                sort: `${String(change.value.createdAt).padStart(15, '0')}#${change.value.id}`,
                value: change.value,
              },
              ConditionExpression:
                change.expectedVersion === 'absent'
                  ? 'attribute_not_exists(pk)'
                  : '#version = :expected',
              ...(change.expectedVersion === 'absent'
                ? {}
                : {
                    ExpressionAttributeNames: { '#version': 'version' },
                    ExpressionAttributeValues: { ':expected': change.expectedVersion },
                  }),
            },
          })),
        }),
      );
    } catch (error) {
      if (
        error instanceof Error &&
        error.name === 'TransactionCanceledException' &&
        'CancellationReasons' in error &&
        (error.CancellationReasons as { Code?: string }[]).some(
          (reason) => reason.Code === 'ConditionalCheckFailed',
        )
      ) {
        throw new ConflictError();
      }
      throw error;
    }
  }
}
