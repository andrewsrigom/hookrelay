import type { SQSHandler, SQSBatchResponse } from 'aws-lambda';
import { awsStore, readSecret, requiredEnv } from '../../packages/runtime/aws.js';
import { DeliveryWorker } from '../../packages/core/delivery-worker.js';
import { HttpTransport } from '../../packages/delivery/http-transport.js';
import { UrlPolicy } from '../../packages/delivery/url-policy.js';
import { queueMessageSchema } from '../../packages/delivery/queue-message.js';

export const handler: SQSHandler = async (event): Promise<SQSBatchResponse> => {
  const masterKey = await readSecret(requiredEnv('MASTER_KEY_ARN'));
  const worker = new DeliveryWorker({
    store: awsStore(),
    masterKey,
    transport: new HttpTransport(new UrlPolicy()),
  });
  const batchItemFailures: { itemIdentifier: string }[] = [];
  await Promise.all(
    event.Records.map(async (record) => {
      try {
        const job = queueMessageSchema.parse(JSON.parse(record.body));
        if (job.route !== 'delivery') {
          throw new Error('Unexpected queue route');
        }
        await worker.process(job);
      } catch (error) {
        console.error(
          JSON.stringify({
            event: 'queue.record.failed',
            messageId: record.messageId,
            error: error instanceof Error ? error.name : 'UnknownError',
          }),
        );
        batchItemFailures.push({ itemIdentifier: record.messageId });
      }
    }),
  );

  // Committed recipient failures do not retry this SQS message.
  return { batchItemFailures };
};
