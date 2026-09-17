# HTTP API

Local base URL: `http://127.0.0.1:4310/api`. Cloud requests require `Authorization: Bearer <api-key>`. Mutations require `Content-Type: application/json`. The local dashboard uses the same routes.

| Method | Route                     | Result                                                   |
| ------ | ------------------------- | -------------------------------------------------------- |
| GET    | `/health`                 | Health and authentication requirement                    |
| GET    | `/overview`               | Endpoints, last 200 deliveries, last 100 event summaries |
| POST   | `/endpoints`              | Create endpoint; signing secret is returned once         |
| PATCH  | `/endpoints/{id}`         | Set `active` true or false                               |
| POST   | `/events`                 | Accept an event, or recognize a repeated ID              |
| GET    | `/deliveries/{id}`        | Delivery, exact outbound payload, and attempts           |
| POST   | `/deliveries/{id}/replay` | Create a new delivery from a failed one                  |
| GET    | `/receiver`               | Local receiver behavior                                  |
| PUT    | `/receiver`               | Change local receiver behavior                           |

## Create an endpoint

```bash
curl -sS http://127.0.0.1:4310/api/endpoints \
  -H 'Content-Type: application/json' \
  -d '{"name":"Fulfillment notifications","url":"http://127.0.0.1:4311/hooks/communications","eventTypes":["fulfillment.shipped"]}'
```

This example adds a subscriber for shipment events; the seeded order recipients remain. The response contains `endpoint` and `signingSecret`. Overview responses never expose the encrypted or plaintext secret. A caller that already manages a secret can include a URL-safe `signingSecret` between 32 and 256 characters; otherwise HookRelay generates one. Public deployments accept only public HTTPS destinations on port 443. `*` subscribes to every event type.

## Publish with an idempotency ID

```bash
curl -i http://127.0.0.1:4310/api/events \
  -H 'Content-Type: application/json' \
  -d '{"id":"evt_order_1042","type":"order.confirmed","data":{"orderId":"ord_1042","currency":"BRL","totalMinor":15990}}'
```

First publication: **202 Accepted**. Same ID and same content: **200**, `duplicate: true`, with no new deliveries. Same ID and changed content: **409 Conflict**. An event with zero matching active destinations is still recorded and reports an empty `deliveryIds` array. IDs accept letters, digits, `_`, and `-`; maximum 100 characters.

## Receiver contract

```text
POST /your-webhook-path
Content-Type: application/json
Webhook-Id: dlv_...
Webhook-Event-Id: evt_...
Webhook-Endpoint-Id: ep_...
Webhook-Attempt: <positive integer>
Webhook-Timestamp: <Unix seconds>
Webhook-Signature: v1=<hex HMAC>
```

```json
{
  "id": "evt_order_1042",
  "type": "order.confirmed",
  "createdAt": "2026-09-15T18:00:00.000Z",
  "data": { "orderId": "ord_1042", "currency": "BRL", "totalMinor": 15990 }
}
```

Compute HMAC-SHA256 with the destination signing secret over:

```text
<timestamp>.<deliveryId>.<original request body bytes>
```

Compare in constant time. Reject messages more than five minutes away from your clock. Verify the original body before parsing or changing its JSON representation. `Webhook-Attempt` starts at 1 and helps with diagnostics; do not use it as the deduplication key. Then atomically recognize the delivery ID alongside the business action, and return HTTP 2xx when accepted.

The receiver in `apps/receiver/server.ts` verifies this signature and commits one `RECEIVER_EFFECT` record per delivery ID. That record stands in for a downstream business action; a retry with the same ID returns HTTP 200 without adding another record. **Drop first reply** closes the first connection after committing the record, so the retry demonstrates lost-acknowledgement recovery. A real recipient must commit its own business action and delivery ID atomically. If manual replay must not repeat that action, it must also deduplicate by event ID and an appropriate business key.

## Error responses

Errors have an `error` message. Input validation may also return `fields`. HTTP 400 means invalid input, 401 invalid cloud credentials, 403 forbidden local Host/Origin, 404 missing resource, 409 state conflict, 413 oversized payload, 415 unsupported content type, and 503 temporary infrastructure/DNS unavailability.
