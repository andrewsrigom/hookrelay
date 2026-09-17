# Trace a cloud delivery

This lab follows the development acceptance run through the AWS Console and CLI. It uses synthetic events and pauses its endpoints when complete.

## Prerequisites

- The `HookRelay-dev` stack is deployed.
- The `hookrelay` AWS profile resolves to the project role.
- The repository dependencies are installed.

Confirm the identity and region before reading or changing resources:

```bash
AWS_PROFILE=hookrelay aws sts get-caller-identity
AWS_PROFILE=hookrelay aws configure get region
```

## 1. Start from CloudFormation

Open **CloudFormation**, select `HookRelay-dev`, and inspect:

- **Resources** for the APIs, Lambdas, DynamoDB table, queues, secrets, log groups, and alarms.
- **Outputs** for resource identifiers used by local scripts.
- **Events** for the latest deployment history.

Do not copy account IDs, ARNs, API URLs, or secret values into committed notes.

## 2. Run the acceptance command

From the repository:

```bash
AWS_PROFILE=hookrelay pnpm aws:validate
```

Expected results:

- The API rejects an unauthenticated request.
- A controlled 401 reaches terminal delivery state and its synthetic failure message is removed.
- A signed webhook succeeds with HTTP 200 on attempt 1.
- A second signed webhook receives 503 on attempt 1 and 200 on attempt 2.
- Both validation endpoints finish paused.

## 3. Follow the Lambda logs

In **CloudWatch → Log groups**, open the groups whose names contain:

- `ApiLogs`
- `DispatcherLogs`
- `WorkerLogs`
- `ValidationReceiverLogs`

The receiver log records event ID, delivery ID, and attempt number. It does not record signatures, signing keys, authorization headers, or payload data.

## 4. Inspect the records

Open **DynamoDB → Tables**, select the table beginning with `HookRelay-dev-State`, and use **Explore table items**.

Filter or search for event IDs beginning with:

- `evt_hookrelay_cloud_success_`
- `evt_hookrelay_cloud_retry_`

Follow each event's delivery IDs. The retry delivery should have two attempt records with status codes 503 and 200.

## 5. Check queues and alarms

Open **SQS** and confirm that the delivery and failure queues have no visible validation messages. Then open **CloudWatch → Alarms**. A terminal validation can briefly move the failed-delivery alarm to `ALARM`; it returns to `OK` after queue cleanup and the next metric evaluation.

## 6. Stop paying for the lab

Keep the stack only while you are studying it. When finished:

```bash
AWS_PROFILE=hookrelay pnpm cdk destroy HookRelay -c stage=dev
```

The project-specific CDK bootstrap stack remains available for later deployments.
