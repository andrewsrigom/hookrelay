import { useState, type SubmitEvent } from 'react';
import { Check, Copy, Send, ArrowRight } from 'lucide-react';
import type { PublicEndpoint, RelayEvent } from '../../../../packages/core/model.js';
import { api, message } from '../api.js';
import { Modal } from './ui.js';

export function PublishForm({
  endpoints,
  onClose,
  onDone,
}: {
  endpoints: PublicEndpoint[];
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [type, setType] = useState('order.confirmed');
  const [id, setId] = useState('');
  const [payload, setPayload] = useState(
    JSON.stringify(
      {
        orderId: 'ord_1042',
        currency: 'BRL',
        totalMinor: 15990,
        items: [{ sku: 'SKU-101', quantity: 2 }],
      },
      null,
      2,
    ),
  );
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const count = endpoints.filter(
    (endpoint) =>
      endpoint.active && (endpoint.eventTypes.includes(type) || endpoint.eventTypes.includes('*')),
  ).length;
  const submit = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError('');
    setPending(true);

    try {
      const data: unknown = JSON.parse(payload);

      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new Error('Payload must be a JSON object.');
      }

      const result = await api<{ event: RelayEvent; duplicate: boolean }>('/events', 'POST', {
        type,
        data,
        ...(id.trim() ? { id: id.trim() } : {}),
      });
      onDone(
        result.duplicate
          ? 'Event already accepted. No duplicate deliveries created.'
          : `Event accepted. ${result.event.deliveryIds.length} deliveries created.`,
      );
    } catch (error) {
      setError(error instanceof SyntaxError ? 'Enter valid JSON.' : message(error));
    } finally {
      setPending(false);
    }
  };

  return (
    <Modal title="Publish event" onClose={onClose} canClose={!pending}>
      <form
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <p className="form-intro">Each subscribed endpoint receives an independent delivery.</p>
        <label>
          Event type
          <input
            required
            autoFocus
            value={type}
            onChange={(event) => setType(event.target.value)}
            placeholder="order.confirmed"
          />
        </label>
        <label>
          Event ID <span className="optional">optional</span>
          <input
            value={id}
            onChange={(event) => setId(event.target.value)}
            placeholder="Generated automatically"
          />
          <small>Reuse the same ID and payload if you need to retry publication.</small>
        </label>
        <label>
          Payload <span className="optional">JSON · up to 32 KB</span>
          <textarea
            className="code-input"
            rows={8}
            required
            spellCheck={false}
            value={payload}
            onChange={(event) => setPayload(event.target.value)}
          />
        </label>
        <div className={`form-summary ${count === 0 ? 'warning' : ''}`}>
          <Send size={16} />
          {count
            ? `${count} active endpoints will receive this event.`
            : 'No active endpoint subscribes to this type. The event will be stored without deliveries.'}
        </div>
        {error ? (
          <div className="form-error" role="alert">
            {error}
          </div>
        ) : null}
        <div className="form-actions">
          <button type="button" className="secondary-button" onClick={onClose} disabled={pending}>
            Cancel
          </button>
          <button className="primary-button" disabled={pending}>
            {pending ? 'Publishing…' : 'Publish event'}
            <ArrowRight size={16} />
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function EndpointForm({
  onClose,
  onDone,
  receiverOrigin,
}: {
  onClose: () => void;
  onDone: () => void;
  receiverOrigin?: string;
}) {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [types, setTypes] = useState('order.confirmed');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [secret, setSecret] = useState('');
  const [copied, setCopied] = useState(false);
  const submit = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError('');
    setPending(true);

    try {
      const result = await api<{ signingSecret: string }>('/endpoints', 'POST', {
        name,
        url,
        eventTypes: [
          ...new Set(
            types
              .split(',')
              .map((type) => type.trim())
              .filter(Boolean),
          ),
        ],
      });
      setSecret(result.signingSecret);
      onDone();
    } catch (error) {
      setError(message(error));
    } finally {
      setPending(false);
    }
  };

  return (
    <Modal
      title={secret ? 'Endpoint created' : 'Add endpoint'}
      onClose={onClose}
      canClose={!pending}
    >
      {secret ? (
        <div className="secret-state">
          <div className="success-icon">
            <Check size={28} />
          </div>
          <h3>Save the signing secret</h3>
          <p>
            This is the only time it will be shown. Configure your receiver to verify signatures.
          </p>
          <code className="secret-code">{secret}</code>
          <button
            className="secondary-button"
            onClick={() => {
              void navigator.clipboard
                .writeText(secret)
                .then(() => setCopied(true))
                .catch(() => setError('Select and copy the secret manually.'));
            }}
          >
            <Copy size={15} />
            {copied ? 'Copied' : 'Copy secret'}
          </button>
          {error ? <p role="alert">{error}</p> : null}
          <div className="form-actions">
            <button className="primary-button" onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      ) : (
        <form
          onSubmit={(event) => {
            void submit(event);
          }}
        >
          <p className="form-intro">Choose a receiving URL and event types.</p>
          <label>
            Endpoint name
            <input
              autoFocus
              required
              maxLength={80}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Warehouse service"
            />
          </label>
          <label>
            Receiving URL
            <input
              required
              type="url"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://api.example.com/webhooks"
            />
            <small>
              Public HTTPS.{' '}
              {receiverOrigin ? `For local testing: ${receiverOrigin}/hooks/communications` : ''}
            </small>
          </label>
          <label>
            Event types
            <input
              required
              value={types}
              onChange={(event) => setTypes(event.target.value)}
              placeholder="order.confirmed, fulfillment.shipped"
            />
            <small>Separate types with commas. Use * for all event types.</small>
          </label>
          {error ? (
            <div className="form-error" role="alert">
              {error}
            </div>
          ) : null}
          <div className="form-actions">
            <button type="button" className="secondary-button" onClick={onClose} disabled={pending}>
              Cancel
            </button>
            <button className="primary-button" disabled={pending}>
              {pending ? 'Creating…' : 'Create endpoint'}
              <ArrowRight size={16} />
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
