# Verification

Checks ran on 2026-09-16 in Ubuntu 20.04 WSL with Node.js 24.19.0 and pnpm 10.32.0.

| Check                                     | Result                                                                                                                                                                                                                                       |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm check`                              | TypeScript, ESLint, and 65 unit, contract, storage, receiver, and HTTP tests passed.                                                                                                                                                         |
| `pnpm format:check` and `pnpm build`      | Formatting passed; the dashboard and four Lambda entry points bundled.                                                                                                                                                                       |
| `pnpm test:flow`                          | Real loopback HTTP covered signatures, retries, terminal failure, replay, lost acknowledgement, and recovery after restart.                                                                                                                  |
| `pnpm test:integration`                   | Five tests passed through the AWS SDK against DynamoDB Local 3.3.1.                                                                                                                                                                          |
| `pnpm synth` and `pnpm verify:synth`      | CDK generated a dev template with four Lambdas, two HTTP APIs, four encrypted queues, three project-named secrets, six short-retention log groups, on-demand DynamoDB, scoped IAM actions, and no NAT Gateway, OpenSearch, or RDS resources. |
| `AWS_PROFILE=hookrelay pnpm aws:validate` | The deployed dev stack passed authentication, the managed delivery path, signed HTTPS acceptance, a 503 to 200 retry, terminal recording, selective queue cleanup, and endpoint pause cleanup.                                               |
| Browser                                   | Chromium covered publication, response changes, delivery inspection, and replay. Axe found no violations in the tested desktop overview, mobile overview, or delivery detail views.                                                          |
| `pnpm dev:fresh`                          | A separate run started with three endpoints, empty history, and its own SQLite database and key.                                                                                                                                             |

## Order flow

Publishing `evt_order_1042` created three `order.confirmed` deliveries. Communications accepted on attempt 1; warehouse accepted after two 503 responses; analytics failed after five 503 responses. Replaying analytics after changing its response to 200 created a linked successful delivery and kept the original attempts.

The lost-acknowledgement flow made the receiver save one `RECEIVER_EFFECT` record and drop its first reply. After restart, the retry received 200 with the same delivery ID. Two HTTP receptions produced one effect record.

The dashboard image shows the original order deliveries; the mobile image was captured later, after replay and other event types, so their totals differ.

## Validation limits

- The signed validation receiver is a separate Lambda and HTTP API in the same development stack. Acceptance against a recipient owned and deployed by another system remains outside this repository.
- Processing-DLQ redrive, outbox failure recovery, queue-age alarms, HTTP 5xx alarms, and the outbox repair command have not been exercised in the AWS account. Their local logic and synthesized resources are covered separately.
- The dashboard remains a local application; cloud frontend hosting is outside this release.
