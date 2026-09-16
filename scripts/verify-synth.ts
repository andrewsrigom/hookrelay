import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

type Resource = {
  Type: string;
  Properties?: Record<string, unknown>;
  DeletionPolicy?: string;
  UpdateReplacePolicy?: string;
};

const template = JSON.parse(await readFile('cdk.out/HookRelay.template.json', 'utf8')) as {
  Resources: Record<string, Resource>;
  Outputs: Record<string, { Value: unknown }>;
};

const resources = Object.values(template.Resources);

assert.equal(resources.filter((r) => r.Type === 'AWS::Lambda::Function').length, 3);

assert.equal(resources.filter((r) => r.Type === 'AWS::SQS::Queue').length, 4);

assert(
  resources
    .filter((r) => r.Type === 'AWS::SQS::Queue')
    .every((r) => r.Properties?.['SqsManagedSseEnabled'] === true),
);

const secrets = resources.filter((r) => r.Type === 'AWS::SecretsManager::Secret');
assert.equal(secrets.length, 2);
assert(secrets.every((secret) => secret.DeletionPolicy === 'Delete'));
assert(secrets.every((secret) => secret.UpdateReplacePolicy === 'Delete'));

const table = resources.find((r) => r.Type === 'AWS::DynamoDB::Table');
assert(table);
assert.equal(table.DeletionPolicy, 'Delete');
assert.equal(table.UpdateReplacePolicy, 'Delete');
assert.equal(table.Properties?.['DeletionProtectionEnabled'], false);
assert.equal(
  (table.Properties?.['PointInTimeRecoverySpecification'] as Record<string, unknown>)?.[
    'PointInTimeRecoveryEnabled'
  ],
  false,
);

const mappings = resources.filter((r) => r.Type === 'AWS::Lambda::EventSourceMapping');

assert.equal(mappings.length, 2);

assert(mappings.every((r) => JSON.stringify(r.Properties).includes('ReportBatchItemFailures')));

assert(JSON.stringify(table.Properties).includes('NEW_IMAGE'));
assert.equal(template.Outputs['DeploymentStage']?.Value, 'dev');

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
  'Verified: disposable dev data, 3 Lambdas, 4 encrypted queues, stream outbox, partial failures, 2 secrets, scoped IAM actions.',
);
