import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { SQSClient } from '@aws-sdk/client-sqs';
import { DynamoStore } from '../storage/dynamo-store.js';
import { z } from 'zod';

let documentClient: DynamoDBDocumentClient | undefined;

let secretClient: SecretsManagerClient | undefined;

let queueClient: SQSClient | undefined;

const secretCache = new Map<string, { value: string; expiresAt: number }>();

export function requiredEnv(name: string): string {
  return z.string().min(1).parse(process.env[name]);
}

export function awsStore() {
  documentClient ??= DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  });
  return new DynamoStore(documentClient, requiredEnv('TABLE_NAME'));
}

export function sqsClient(): SQSClient {
  queueClient ??= new SQSClient({});
  return queueClient;
}

export async function readSecret(arn: string): Promise<string> {
  const cached = secretCache.get(arn);

  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  secretClient ??= new SecretsManagerClient({});
  const result = await secretClient.send(new GetSecretValueCommand({ SecretId: arn }));
  const value = z.string().min(32).parse(result.SecretString);
  secretCache.set(arn, { value, expiresAt: Date.now() + 300000 });

  return value;
}
