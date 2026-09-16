import type { DynamoDBStreamHandler, DynamoDBBatchResponse } from 'aws-lambda';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { requiredEnv, sqsClient } from '../../packages/runtime/aws.js';
import { queueMessageSchema } from '../../packages/delivery/queue-message.js';

export const handler: DynamoDBStreamHandler = async (event): Promise<DynamoDBBatchResponse> => {
  const batchItemFailures: { itemIdentifier: string }[] = [];
  for (const record of event.Records) {
    try {
      if (record.eventName !== 'INSERT' || !record.dynamodb?.NewImage) {
        continue;
      }

      const row = unmarshall(record.dynamodb.NewImage as Record<string, AttributeValue>);

      if (row['pk'] !== 'OUTBOX') {
        continue;
      }

      const job = queueMessageSchema.parse(row['value']);
      const delay = Math.max(0, Math.ceil((job.availableAt - Date.now()) / 1000));

      if (delay > 900) {
        throw new Error('Job exceeds SQS delay limit');
      }

      await sqsClient().send(
        new SendMessageCommand({
          QueueUrl: requiredEnv(
            job.route === 'delivery' ? 'DELIVERY_QUEUE_URL' : 'FAILED_QUEUE_URL',
          ),
          MessageBody: JSON.stringify(job),
          DelaySeconds: job.route === 'delivery' ? delay : 0,
        }),
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          event: 'outbox.publish.failed',
          error: error instanceof Error ? error.name : 'UnknownError',
        }),
      );
      if (!record.dynamodb?.SequenceNumber) {
        throw error;
      }
      batchItemFailures.push({ itemIdentifier: record.dynamodb.SequenceNumber });
    }
  }
  return { batchItemFailures };
};
