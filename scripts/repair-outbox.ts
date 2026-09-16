import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { awsStore, requiredEnv, sqsClient } from '../packages/runtime/aws.js';
import { kinds, type Delivery, type Job } from '../packages/core/model.js';
import { idSchema } from '../packages/core/validation.js';
import { queueMessageSchema } from '../packages/delivery/queue-message.js';

const index = process.argv.indexOf('--job');

if (index < 0) {
  throw new Error('Usage: pnpm aws:repair-outbox --job <outbox-id>');
}

const id = idSchema.parse(process.argv[index + 1]);

const store = awsStore();

const record = await store.get<Job>(kinds.job, id);

if (!record) {
  throw new Error('Outbox record not found');
}

const job = queueMessageSchema.parse(record);

const delivery = await store.get<Delivery>(kinds.delivery, job.deliveryId);

if (!delivery) {
  throw new Error('Associated delivery not found');
}

if ((delivery.leaseUntil ?? 0) > Date.now()) {
  throw new Error('Delivery is still leased; retry after lease expiry');
}

if (
  job.route === 'delivery' &&
  (['delivered', 'failed'].includes(delivery.status) ||
    delivery.attemptCount >= job.expectedAttempt)
) {
  console.log('No action: this delivery attempt is already complete.');
} else {
  if (job.route === 'delivery' && job.expectedAttempt !== delivery.attemptCount + 1) {
    throw new Error('Job is not the expected next attempt');
  }

  if (job.route === 'dead-letter' && delivery.status !== 'failed') {
    throw new Error('Delivery is not terminal');
  }

  const delay = Math.max(
    0,
    Math.ceil((Math.max(job.availableAt, delivery.nextAttemptAt) - Date.now()) / 1000),
  );

  if (delay > 900) {
    throw new Error('Job is outside the SQS delay window; run the repair closer to its due time');
  }

  await sqsClient().send(
    new SendMessageCommand({
      QueueUrl: requiredEnv(job.route === 'delivery' ? 'DELIVERY_QUEUE_URL' : 'FAILED_QUEUE_URL'),
      MessageBody: JSON.stringify(job),
      DelaySeconds: job.route === 'delivery' ? delay : 0,
    }),
  );
  console.log(`Re-published outbox job ${job.id} for delivery ${job.deliveryId}.`);
}
