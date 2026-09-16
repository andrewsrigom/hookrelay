import { Cable, Send, ListChecks, ShieldCheck } from 'lucide-react';

export function Guide() {
  return (
    <div className="guide-grid">
      <section className="panel guide-section">
        <span className="eyebrow">GET STARTED</span>
        <h2>Deliver an order event</h2>
        <div className="guide-step">
          <Cable size={22} />
          <div>
            <h3>1. Choose recipients</h3>
            <p>
              Use the local receivers or add an endpoint with its event types and signing secret.
            </p>
          </div>
        </div>
        <div className="guide-step">
          <Send size={22} />
          <div>
            <h3>2. Publish an event</h3>
            <p>
              Publish <code>order.confirmed</code> with an order ID and JSON payload. Reuse the
              event ID to prevent duplicate deliveries.
            </p>
          </div>
        </div>
        <div className="guide-step">
          <ListChecks size={22} />
          <div>
            <h3>3. Inspect deliveries</h3>
            <p>
              Open a delivery to see every attempt. Replay a failed delivery after fixing the
              receiver.
            </p>
          </div>
        </div>
      </section>
      <section className="panel guide-section">
        <span className="eyebrow">RECEIVER CONTRACT</span>
        <h2>Request sent to your endpoint</h2>
        <pre className="payload-view" tabIndex={0}>{`POST /webhooks
Content-Type: application/json
Webhook-Id: dlv_…
Webhook-Event-Id: evt_…
Webhook-Endpoint-Id: ep_…
Webhook-Timestamp: 1789495205
Webhook-Signature: v1=…

{
  "id": "evt_order_1042",
  "type": "order.confirmed",
  "createdAt": "2026-09-15T18:00:00.000Z",
  "data": { "orderId": "ord_1042", "totalMinor": 15990 }
}`}</pre>
        <p>
          Return HTTP 2xx to acknowledge. Timeouts, 408, 429, and 5xx responses retry up to five
          attempts.
        </p>
      </section>
      <section className="panel guide-section full-width">
        <div className="guide-step">
          <ShieldCheck size={24} />
          <div>
            <h3>Verify signatures and deduplicate deliveries</h3>
            <p>
              The HMAC-SHA256 signature covers <code>timestamp.deliveryId.rawBody</code>. Check the
              timestamp. Retries keep the same delivery ID; store it to avoid repeating a completed
              action. A manual replay has a new delivery ID.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
