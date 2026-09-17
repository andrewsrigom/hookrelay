import { resolve } from 'node:path';
import {
  Stack,
  Duration,
  RemovalPolicy,
  CfnOutput,
  Tags,
  aws_dynamodb as dynamodb,
  aws_sqs as sqs,
  aws_lambda as lambda,
  aws_lambda_nodejs as nodejs,
  aws_lambda_event_sources as sources,
  aws_apigatewayv2 as gateway,
  aws_apigatewayv2_integrations as integrations,
  aws_secretsmanager as secrets,
  aws_logs as logs,
  aws_cloudwatch as cloudwatch,
  type StackProps,
} from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { policy } from '../packages/core/policy.js';

export interface HookRelayStackProps extends StackProps {
  deploymentStage: 'dev' | 'production';
}

export class HookRelayStack extends Stack {
  constructor(scope: Construct, id: string, props: HookRelayStackProps) {
    super(scope, id, props);
    const retainData = props.deploymentStage === 'production';
    const dataRemovalPolicy = retainData ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;
    const logRetention = retainData ? logs.RetentionDays.ONE_MONTH : logs.RetentionDays.ONE_WEEK;

    Tags.of(this).add('Project', 'HookRelay');
    Tags.of(this).add('Environment', props.deploymentStage);

    const table = new dynamodb.Table(this, 'State', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: retainData },
      deletionProtection: retainData,
      stream: dynamodb.StreamViewType.NEW_IMAGE,
      removalPolicy: dataRemovalPolicy,
    });
    table.addGlobalSecondaryIndex({
      indexName: 'by-created',
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sort', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });
    const queue = (name: string) =>
      new sqs.Queue(this, name, {
        encryption: sqs.QueueEncryption.SQS_MANAGED,
        enforceSSL: true,
        retentionPeriod: Duration.days(14),
      });
    const processingDlq = queue('ProcessingDlq');
    const outboxDlq = queue('OutboxDlq');
    const failedDeliveries = queue('FailedDeliveries');
    const deliveries = new sqs.Queue(this, 'Deliveries', {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: Duration.days(4),
      visibilityTimeout: Duration.seconds(policy.queueVisibilitySeconds),
      deadLetterQueue: { queue: processingDlq, maxReceiveCount: policy.maxInfrastructureReceives },
    });
    const masterKey = new secrets.Secret(this, 'SigningEncryptionKey', {
      secretName: `${this.stackName}/signing-encryption-key`,
      generateSecretString: { passwordLength: 48, excludePunctuation: true },
    });
    const apiKey = new secrets.Secret(this, 'ApiKey', {
      secretName: `${this.stackName}/api-key`,
      generateSecretString: { passwordLength: 48, excludePunctuation: true },
    });
    // Production retains encryption material with its data. Development is disposable.
    masterKey.applyRemovalPolicy(dataRemovalPolicy);
    apiKey.applyRemovalPolicy(dataRemovalPolicy);
    const createFunction = (
      name: string,
      entry: string,
      timeout: number,
      environment: Record<string, string>,
    ) => {
      const logGroup = new logs.LogGroup(this, `${name}Logs`, {
        retention: logRetention,
      });
      logGroup.applyRemovalPolicy(dataRemovalPolicy);

      return new nodejs.NodejsFunction(this, name, {
        entry: resolve(entry),
        handler: 'handler',
        projectRoot: resolve('.'),
        depsLockFilePath: resolve('pnpm-lock.yaml'),
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        memorySize: 512,
        timeout: Duration.seconds(timeout),
        logGroup,
        bundling: { target: 'node22', minify: true, sourceMap: true, externalModules: [] },
        environment,
      });
    };

    const api = createFunction('Api', 'apps/aws/api.ts', 15, {
      TABLE_NAME: table.tableName,
      MASTER_KEY_ARN: masterKey.secretArn,
      API_KEY_ARN: apiKey.secretArn,
    });
    const worker = createFunction('Worker', 'apps/aws/worker.ts', policy.workerTimeoutSeconds, {
      TABLE_NAME: table.tableName,
      MASTER_KEY_ARN: masterKey.secretArn,
    });
    const dispatcher = createFunction('Dispatcher', 'apps/aws/dispatcher.ts', 30, {
      DELIVERY_QUEUE_URL: deliveries.queueUrl,
      FAILED_QUEUE_URL: failedDeliveries.queueUrl,
    });

    for (const fn of [api, worker]) {
      table.grant(
        fn,
        'dynamodb:GetItem',
        'dynamodb:PutItem',
        'dynamodb:Query',
        'dynamodb:ConditionCheckItem',
      );
      masterKey.grantRead(fn);
    }

    apiKey.grantRead(api);
    deliveries.grantSendMessages(dispatcher);
    failedDeliveries.grantSendMessages(dispatcher);
    dispatcher.addEventSource(
      new sources.DynamoEventSource(table, {
        startingPosition: lambda.StartingPosition.TRIM_HORIZON,
        batchSize: 10,
        retryAttempts: 10,
        maxRecordAge: Duration.hours(6),
        bisectBatchOnError: true,
        reportBatchItemFailures: true,
        onFailure: new sources.SqsDlq(outboxDlq),
        filters: [
          lambda.FilterCriteria.filter({
            eventName: lambda.FilterRule.isEqual('INSERT'),
            dynamodb: { NewImage: { pk: { S: lambda.FilterRule.isEqual('OUTBOX') } } },
          }),
        ],
      }),
    );
    worker.addEventSource(
      new sources.SqsEventSource(deliveries, {
        batchSize: 4,
        reportBatchItemFailures: true,
        maxConcurrency: 2,
      }),
    );
    const httpApi = new gateway.HttpApi(this, 'HttpApi', { apiName: 'HookRelay' });
    httpApi.addRoutes({
      path: '/api/{proxy+}',
      methods: [gateway.HttpMethod.ANY],
      integration: new integrations.HttpLambdaIntegration('ApiIntegration', api),
    });
    const stage = httpApi.defaultStage!.node.defaultChild as gateway.CfnStage;
    stage.defaultRouteSettings = { throttlingRateLimit: 20, throttlingBurstLimit: 40 };
    const apiLogs = new logs.LogGroup(this, 'AccessLogs', {
      retention: logRetention,
    });
    apiLogs.applyRemovalPolicy(dataRemovalPolicy);

    stage.accessLogSettings = {
      destinationArn: apiLogs.logGroupArn,
      format: JSON.stringify({
        requestId: '$context.requestId',
        status: '$context.status',
        latency: '$context.responseLatency',
      }),
    };

    // Native queue/HTTP metrics catch failures that partial responses do not count as Lambda errors.
    for (const [name, source] of [
      ['Processing', processingDlq],
      ['Outbox', outboxDlq],
      ['Delivery', failedDeliveries],
    ] as const) {
      new cloudwatch.Alarm(this, `${name}FailureAlarm`, {
        metric: source.metricApproximateNumberOfMessagesVisible(),
        threshold: 1,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
    }

    new cloudwatch.Alarm(this, 'QueueAgeAlarm', {
      metric: deliveries.metricApproximateAgeOfOldestMessage(),
      threshold: 600,
      evaluationPeriods: 2,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    new cloudwatch.Alarm(this, 'HttpFailureAlarm', {
      metric: new cloudwatch.Metric({
        namespace: 'AWS/ApiGateway',
        metricName: '5xx',
        dimensionsMap: { ApiId: httpApi.apiId },
        statistic: 'Sum',
        period: Duration.minutes(5),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    new CfnOutput(this, 'DeploymentStage', { value: props.deploymentStage });
    new CfnOutput(this, 'ApiUrl', { value: httpApi.apiEndpoint });
    new CfnOutput(this, 'TableName', { value: table.tableName });
    new CfnOutput(this, 'ApiKeyArn', { value: apiKey.secretArn });
    new CfnOutput(this, 'DeliveryQueueUrl', { value: deliveries.queueUrl });
    new CfnOutput(this, 'FailedDeliveryQueueUrl', { value: failedDeliveries.queueUrl });
    new CfnOutput(this, 'OutboxFailureQueueUrl', { value: outboxDlq.queueUrl });
  }
}
