import { useState } from 'react';
import { Cable, ExternalLink, Pause, Play, Plus, ShieldCheck } from 'lucide-react';
import type { PublicEndpoint } from '../../../../packages/core/model.js';
import { api, message } from '../api.js';
import { Empty, dateTime } from './ui.js';

export function Endpoints({
  endpoints,
  onCreate,
  onChange,
  notify,
}: {
  endpoints: PublicEndpoint[];
  onCreate: () => void;
  onChange: () => void;
  notify: (message: string, error?: boolean) => void;
}) {
  const [pending, setPending] = useState<string>();
  const toggle = async (endpoint: PublicEndpoint) => {
    setPending(endpoint.id);
    try {
      await api(`/endpoints/${endpoint.id}`, 'PATCH', { active: !endpoint.active });
      notify(
        endpoint.active
          ? 'Endpoint paused. Pending deliveries will fail when processed.'
          : 'Endpoint resumed.',
      );
      onChange();
    } catch (error) {
      notify(message(error), true);
    } finally {
      setPending(undefined);
    }
  };
  return (
    <>
      <div className="section-toolbar">
        <span>{endpoints.length} of 20 endpoints registered</span>
        <button className="secondary-button" onClick={onCreate}>
          <Plus size={17} />
          Add endpoint
        </button>
      </div>
      {endpoints.length ? (
        <div className="endpoint-grid">
          {endpoints.map((endpoint, index) => (
            <article className="panel endpoint-card" key={endpoint.id}>
              <div className="endpoint-top">
                <span className={`endpoint-icon color-${index % 3}`}>
                  <Cable size={23} />
                </span>
                <span className={`badge ${endpoint.active ? 'delivered' : 'queued'}`}>
                  <span className="status-dot" />
                  {endpoint.active ? 'Active' : 'Paused'}
                </span>
              </div>
              <h2>{endpoint.name}</h2>
              <div className="endpoint-url">
                <ExternalLink size={13} />
                <span title={endpoint.url}>{endpoint.url}</span>
              </div>
              <div className="endpoint-types">
                {endpoint.eventTypes.map((type) => (
                  <code key={type}>{type}</code>
                ))}
              </div>
              <footer>
                <span>Created {dateTime(endpoint.createdAt)}</span>
                <button
                  className="text-button"
                  disabled={Boolean(pending)}
                  onClick={() => {
                    void toggle(endpoint);
                  }}
                >
                  {endpoint.active ? <Pause size={14} /> : <Play size={14} />}{' '}
                  {pending === endpoint.id ? 'Saving…' : endpoint.active ? 'Pause' : 'Resume'}
                </button>
              </footer>
            </article>
          ))}
        </div>
      ) : (
        <section className="panel">
          <Empty
            title="No endpoints yet"
            description="Add a receiving URL and event subscriptions."
          >
            <button className="primary-button" onClick={onCreate}>
              Add endpoint
            </button>
          </Empty>
        </section>
      )}
      <div className="info-note">
        <ShieldCheck size={19} />
        <div>
          <strong>Each endpoint has its own signing secret.</strong>
          <p>
            Save the secret when you create the endpoint. Verify signatures before processing
            events.
          </p>
        </div>
      </div>
    </>
  );
}
