import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

type Resource = { Type: string; Properties?: Record<string, unknown> };

const template = JSON.parse(await readFile('cdk.out/HookRelay.template.json', 'utf8')) as {
  Resources: Record<string, Resource>;
};

const resources = Object.values(template.Resources);

assert.equal(resources.filter((r) => r.Type === 'AWS::Lambda::Function').length, 3);

assert.equal(resources.filter((r) => r.Type === 'AWS::SQS::Queue').length, 4);

assert(
  resources
    .filter((r) => r.Type === 'AWS::SQS::Queue')
    .every((r) => r.Properties?.['SqsManagedSseEnabled'] === true),
);

assert.equal(resources.filter((r) => r.Type === 'AWS::SecretsManager::Secret').length, 2);

const mappings = resources.filter((r) => r.Type === 'AWS::Lambda::EventSourceMapping');

assert.equal(mappings.length, 2);

assert(mappings.every((r) => JSON.stringify(r.Properties).includes('ReportBatchItemFailures')));

assert(
  resources.some(
    (r) => r.Type === 'AWS::DynamoDB::Table' && JSON.stringify(r.Properties).includes('NEW_IMAGE'),
  ),
);

for (const resource of resources.filter((r) => r.Type === 'AWS::IAM::Policy')) {
  const document = resource.Properties?.['PolicyDocument'] as {
    Statement: { Action: string | string[] }[];
  };
  for (const statement of document.Statement) {
    const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
    assert(
      actions.every((action) => !action.endsWith('*')),
      `Wildcard IAM action: ${actions.join(',')}`,
    );
  }
}

console.log(
  'Verified: 3 Lambdas, 4 encrypted queues, stream outbox, partial failures, 2 secrets, scoped IAM actions.',
);
