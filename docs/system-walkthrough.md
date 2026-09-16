# System walkthrough

Run `pnpm dev`, open `http://localhost:4317`, and publish `order.confirmed`. The seeded recipients produce separate deliveries: communications accepts, warehouse retries twice, and analytics fails. The [README](../README.md) covers the controls and replay steps.

## Trace an event

| Step    | Code                                  | What happens                                                                                                          |
| ------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Accept  | `packages/core/relay-service.ts`      | Validates the event ID and payload, finds subscriptions, and commits the event, deliveries, and outbox jobs together. |
| Persist | `packages/storage/sqlite-store.ts`    | Stores state and local queue jobs in one SQLite file.                                                                 |
| Process | `packages/core/delivery-worker.ts`    | Claims a delivery, signs the request, records the attempt, and schedules a retry or terminal result.                  |
| Send    | `packages/delivery/http-transport.ts` | Connects to the validated destination and reads its HTTP status.                                                      |
| Receive | `apps/receiver/server.ts`             | Verifies the signature and applies the configured response mode.                                                      |

`packages/core/policy.ts` holds retry delays, timeouts, and limits. `tests/relay.test.ts` and `tests/worker.test.ts` cover the transaction and delivery decisions.

## Why the outbox exists

A separate database write and queue publish can split: the event commits, then the process stops before publishing its job. HookRelay writes the job in the same transaction as the event and delivery. All records commit or none do.

Locally, workers lease outbox jobs from SQLite. On AWS, DynamoDB Streams reports new outbox rows to `apps/aws/dispatcher.ts`, which publishes them to SQS. `packages/storage/dynamo-store.ts` implements the same `Store` contract through the AWS SDK.

## AWS services

| Service                                | Responsibility                                | Code                                   |
| -------------------------------------- | --------------------------------------------- | -------------------------------------- |
| API Gateway and API Lambda             | Receive requests and invoke the relay service | `apps/aws/api.ts`, `infra/stack.ts`    |
| DynamoDB                               | Commit state and outbox rows conditionally    | `packages/storage/dynamo-store.ts`     |
| DynamoDB Streams and dispatcher Lambda | Publish committed outbox jobs                 | `apps/aws/dispatcher.ts`               |
| SQS and worker Lambda                  | Hold jobs and run delivery attempts           | `apps/aws/worker.ts`, `infra/stack.ts` |
| Secrets Manager                        | Store the API key and signing-encryption key  | `infra/stack.ts`                       |
| IAM and CloudWatch                     | Scope permissions and expose failure metrics  | `infra/stack.ts`                       |

`pnpm synth` generates the CloudFormation template; it does not deploy resources. The [AWS runbook](aws-runbook.md) covers account setup and cloud checks.

## Duplicate deliveries

An HTTP recipient may complete its action while its acknowledgement is lost. The next attempt uses the same `Webhook-Id`; the recipient must record that ID with its business action. Manual replay creates a new delivery ID, so actions that must remain unique across replays also need an event-level business key.

Workers use leases and record versions to prevent a stale worker from overwriting a newer result. `pnpm test:flow` exercises a lost acknowledgement across a local restart. See [architecture](architecture.md) for the delivery guarantees and [verification](verification.md) for completed checks.
