# AWS deployment and operations

The CDK stack defines the backend. It has been synthesized and inspected locally; it has not been deployed or validated in an AWS account. Use a development account for the first run.

## Before deployment

Use a development account and choose a region. The account root user is for exceptional account tasks; use a separate identity for routine tests. With a non-root IAM Console user, AWS CLI 2.32.0 or newer can obtain temporary credentials:

```bash
aws login --profile hookrelay-dev --region us-west-2
export AWS_PROFILE=hookrelay-dev
aws sts get-caller-identity
```

A non-root Console identity needs the `SignInLocalDevelopmentAccess` permission for `aws login`. If your account provides IAM Identity Center, configure an SSO profile and use `aws sso login` instead. Windows and WSL keep separate AWS configuration and login caches; sign in on each system you use.

1. Configure a budget for the development account.
2. Run `pnpm check`, `pnpm build`, `pnpm synth`, and `pnpm verify:synth`.
3. Inspect `cdk.out/HookRelay.template.json` and the intended region/account.

```bash
pnpm cdk bootstrap
pnpm cdk deploy HookRelay
```

The commands above create cloud resources and may incur charges. They are not part of `pnpm dev` or the local verification commands.

## Credentials and first request

The stack outputs `ApiUrl`, `ApiKeyArn`, table name, and queue URLs. Retrieve the API key through Secrets Manager with an authorized operator identity and keep it in the shell environment:

```bash
export HOOKRELAY_API_URL="<ApiUrl output>"
export API_KEY_ARN="<ApiKeyArn output>"
export HOOKRELAY_API_KEY="$(
  aws secretsmanager get-secret-value \
    --secret-id "$API_KEY_ARN" \
    --query SecretString \
    --output text
)"

curl -sS "$HOOKRELAY_API_URL/api/overview" \
  -H "Authorization: Bearer $HOOKRELAY_API_KEY"
```

Cloud routes use a shared bearer API key. There are no user accounts, workspace isolation, or role-based access in this release. The local dashboard is not deployed by the stack. Cloud dashboard hosting and same-origin API routing need a separate setup.

Register a public HTTPS endpoint under your control with `POST /api/endpoints`, configure its returned signing secret, and publish a unique event ID. The loopback receiver is intentionally unavailable to cloud workers.

## Cloud acceptance checks

- Unauthenticated `/api/overview` returns 401. A valid key allows the request.
- A registered endpoint receives the exact signed body and verifies it.
- Repeating an event ID does not create new deliveries. Changed content returns 409.
- The event transaction produces outbox rows, Streams invokes the dispatcher, and SQS invokes the worker.
- A temporary 503 produces a delayed job. A successful result creates no further delivery job.
- Five recipient failures produce `failed` state and a terminal job in FailedDeliveries.
- A message that cannot be processed eventually reaches ProcessingDlq. Fix the root cause before redrive.
- A dispatcher publication failure retries the stream record. Exhausted batches reach OutboxDlq.
- Verify CloudWatch HTTP 5xx and queue-age alarms with a controlled failure.

Alarm definitions currently have **no notification destination**. Add an SNS alarm action for your chosen operations channel if notifications are required; an alarm in CloudWatch alone does not send an email.

## Failure recovery

**Recipient outage:** fix the recipient, then replay the failed delivery through the API or dashboard. The original history remains immutable.

**Worker infrastructure failure:** inspect the worker log and ProcessingDlq. SQS redrive after correcting permissions/configuration can reprocess the original jobs; stale attempt numbers are ignored.

**Outbox dispatch failure:** the stream failure destination contains invocation metadata, not a full durable substitute for every original event. Original OUTBOX rows remain in DynamoDB. Find the relevant pending row, verify its delivery state, and re-publish that specific job with the repair script:

```bash
export TABLE_NAME="<TableName output>"
export DELIVERY_QUEUE_URL="<DeliveryQueueUrl output>"
export FAILED_QUEUE_URL="<FailedDeliveryQueueUrl output>"
pnpm aws:repair-outbox --job "<outbox record ID>"
```

The command validates the row and associated delivery, refuses leased work, skips completed/stale delivery attempts, and publishes only the chosen job. It does not scan or replay every row. It requires real AWS credentials and writes to the selected queue. This repair command has not been executed against a cloud account.

## Retention and removal

The stack retains the DynamoDB table **and both secrets** when removed. They require explicit cleanup after a development run. Retained resources can continue to incur charges. Queue retention is four days for pending deliveries and fourteen days for the failure queues; logs retain one month. Automatic DynamoDB history/outbox cleanup is not implemented.

Do not replace the signing-encryption master key while existing endpoint ciphertext depends on it. A rotation requires a migration or a versioned keyring. API keys are cached for up to five minutes in warm Lambda instances.
