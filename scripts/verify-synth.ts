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

assert.equal(resources.filter((r) => r.Type === 'AWS::Lambda::Function').length, 4);

assert.equal(resources.filter((r) => r.Type === 'AWS::SQS::Queue').length, 4);

assert(
  resources
    .filter((r) => r.Type === 'AWS::SQS::Queue')
    .every((r) => r.Properties?.['SqsManagedSseEnabled'] === true),
);

const secrets = resources.filter((r) => r.Type === 'AWS::SecretsManager::Secret');
assert.equal(secrets.length, 3);
assert(secrets.every((secret) => secret.DeletionPolicy === 'Delete'));
assert(secrets.every((secret) => secret.UpdateReplacePolicy === 'Delete'));
assert.deepEqual(
  new Set(secrets.map((secret) => secret.Properties?.['Name'])),
  new Set([
    'HookRelay-dev/api-key',
    'HookRelay-dev/signing-encryption-key',
    'HookRelay-dev/validation-receiver-signing-key',
  ]),
);

const table = resources.find((r) => r.Type === 'AWS::DynamoDB::Table');
assert(table);
assert.equal(table.DeletionPolicy, 'Delete');
assert.equal(table.UpdateReplacePolicy, 'Delete');
assert.equal(table.Properties?.['BillingMode'], 'PAY_PER_REQUEST');
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

const logGroups = resources.filter((r) => r.Type === 'AWS::Logs::LogGroup');

assert.equal(logGroups.length, 6);
assert(logGroups.every((logGroup) => logGroup.DeletionPolicy === 'Delete'));
assert(logGroups.every((logGroup) => logGroup.UpdateReplacePolicy === 'Delete'));
assert(logGroups.every((logGroup) => logGroup.Properties?.['RetentionInDays'] === 7));

const unexpectedCostResources = new Set([
  'AWS::EC2::NatGateway',
  'AWS::OpenSearchService::Domain',
  'AWS::RDS::DBCluster',
  'AWS::RDS::DBInstance',
]);

assert(resources.every((resource) => !unexpectedCostResources.has(resource.Type)));
assert.equal(resources.filter((resource) => resource.Type === 'AWS::ApiGatewayV2::Api').length, 2);

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
  'Verified: disposable dev data and logs, 4 Lambdas, 2 HTTP APIs, 4 encrypted queues, stream outbox, partial failures, 3 secrets, on-demand DynamoDB, scoped IAM actions, and no high-cost network or database resources.',
);
