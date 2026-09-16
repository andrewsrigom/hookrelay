# Verification

Local checks ran on 2026-09-15 in Ubuntu 20.04 WSL with Node.js 24.19.0 and pnpm 10.32.0.

| Check                                | Result                                                                                                                                                                              |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm check`                         | TypeScript, ESLint, and 61 unit, contract, storage, and HTTP tests passed.                                                                                                          |
| `pnpm format:check` and `pnpm build` | Formatting passed; the dashboard and three Lambda entry points bundled.                                                                                                             |
| `pnpm test:flow`                     | Real loopback HTTP covered signatures, retries, terminal failure, replay, lost acknowledgement, and recovery after restart.                                                         |
| `pnpm test:integration`              | Five tests passed through the AWS SDK against DynamoDB Local 3.3.1.                                                                                                                 |
| `pnpm synth` and `pnpm verify:synth` | CDK generated a template with three Lambdas, four encrypted queues, two secrets, partial batch failures, and scoped IAM actions.                                                    |
| Browser                              | Chromium covered publication, response changes, delivery inspection, and replay. Axe found no violations in the tested desktop overview, mobile overview, or delivery detail views. |
| `pnpm dev:fresh`                     | A separate run started with three endpoints, empty history, and its own SQLite database and key.                                                                                    |

## Order flow

Publishing `evt_order_1042` created three `order.confirmed` deliveries. Communications accepted on attempt 1; warehouse accepted after two 503 responses; analytics failed after five 503 responses. Replaying analytics after changing its response to 200 created a linked successful delivery and kept the original attempts.

The lost-acknowledgement flow made the receiver save one `RECEIVER_EFFECT` record and drop its first reply. After restart, the retry received 200 with the same delivery ID. Two HTTP receptions produced one effect record.

The dashboard image shows the original order deliveries; the mobile image was captured later, after replay and other event types, so their totals differ.

## Validation limits

- No AWS resources have been deployed. Managed Streams, SQS, Lambda, Secrets Manager, IAM, and alarms still need a cloud integration run.
- DynamoDB tests use fake credentials and a loopback endpoint. The SDK retry test stubs its HTTP recipient; `pnpm test:flow` covers real local HTTP.
- SQS dispatcher tests mock SDK responses. The cloud dashboard and outbox repair command have not been exercised against an AWS account.
