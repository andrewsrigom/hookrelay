import { useEffect, useState } from 'react';
import { ArrowUpRight, Check, Clock3, RotateCw, X } from 'lucide-react';
import type { Delivery } from '../../../../packages/core/model.js';
import { api, message, type DeliveryDetail as Detail } from '../api.js';
import { Modal, StatusBadge, dateTime, time } from './ui.js';

export function DeliveryDetail({
  id,
  onClose,
  onReplay,
}: {
  id: string;
  onClose: () => void;
  onReplay: (id: string) => void;
}) {
  const [data, setData] = useState<Detail>();
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    let busy = false;
    const load = async () => {
      if (busy) {
        return;
      }
      busy = true;
      try {
        const next = await api<Detail>(`/deliveries/${id}`, 'GET', undefined, controller.signal);
        if (!controller.signal.aborted) {
          setData(next);
          setError('');
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          setError(message(error));
        }
      } finally {
        busy = false;
      }
    };
    void load();
    const timer = setInterval(() => {
      void load();
    }, 1500);

    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [id]);
  const replay = async () => {
    setPending(true);
    try {
      const delivery = await api<Delivery>(`/deliveries/${id}/replay`, 'POST', {});
      onReplay(delivery.id);
    } catch (error) {
      setError(message(error));
    } finally {
      setPending(false);
    }
  };

  return (
    <Modal title="Delivery details" onClose={onClose} canClose={!pending} wide>
      {error ? (
        <div className="form-error" role="alert">
          {error}
        </div>
      ) : null}
      {data ? (
        <>
          <div className="detail-header">
            <div>
              <span className="eyebrow">{data.delivery.endpointName}</span>
              <h3>{data.delivery.eventType}</h3>
              <code>{data.delivery.id}</code>
            </div>
            <StatusBadge status={data.delivery.status} />
          </div>
          <div className="detail-meta">
            <div>
              <span>Endpoint</span>
              <strong title={data.delivery.endpointUrl}>{data.delivery.endpointUrl}</strong>
            </div>
            <div>
              <span>Created</span>
              <strong>{dateTime(data.delivery.createdAt)}</strong>
            </div>
          </div>
          {data.delivery.replayOf ? (
            <div className="form-summary">
              <RotateCw size={15} />
              Replay of <code>{data.delivery.replayOf.slice(0, 16)}…</code>
            </div>
          ) : null}
          <h4 className="detail-section-title">
            Timeline{' '}
            <span>
              {data.attempts.length} {data.attempts.length === 1 ? 'attempt' : 'attempts'}
            </span>
          </h4>
          <ol className="timeline">
            <li>
              <span className="timeline-icon neutral">
                <ArrowUpRight size={14} />
              </span>
              <div>
                <strong>Delivery created</strong>
                <p>Event accepted and queued.</p>
              </div>
              <time>{time(data.delivery.createdAt)}</time>
            </li>
            {data.attempts.map((attempt) => (
              <li key={attempt.id}>
                <span
                  className={`timeline-icon ${attempt.outcome === 'success' ? 'success' : attempt.outcome === 'retry' ? 'retry' : 'failure'}`}
                >
                  {attempt.outcome === 'success' ? (
                    <Check size={14} />
                  ) : attempt.outcome === 'retry' ? (
                    <RotateCw size={14} />
                  ) : (
                    <X size={14} />
                  )}
                </span>
                <div>
                  <strong>
                    Attempt {attempt.number}{' '}
                    <span className="http-code">
                      {attempt.statusCode ? `HTTP ${attempt.statusCode}` : 'NETWORK'}
                    </span>
                  </strong>
                  <p>
                    {attempt.outcome === 'success'
                      ? 'Endpoint acknowledged the delivery.'
                      : attempt.error}{' '}
                    <span>· {attempt.durationMs} ms</span>
                  </p>
                </div>
                <time>{time(attempt.createdAt)}</time>
              </li>
            ))}
            {data.delivery.status === 'retrying' ? (
              <li>
                <span className="timeline-icon neutral">
                  <Clock3 size={14} />
                </span>
                <div>
                  <strong>Next attempt scheduled</strong>
                  <p>Scheduled for {time(data.delivery.nextAttemptAt)}.</p>
                </div>
              </li>
            ) : null}
          </ol>
          <h4 className="detail-section-title">
            Request body <span>JSON</span>
          </h4>
          <pre className="payload-view" tabIndex={0}>
            {JSON.stringify(data.payload, null, 2)}
          </pre>
          <div className="form-actions">
            <button className="secondary-button" onClick={onClose} disabled={pending}>
              Close
            </button>
            {data.delivery.status === 'failed' ? (
              <button
                className="primary-button"
                disabled={pending}
                onClick={() => {
                  void replay();
                }}
              >
                <RotateCw size={16} />
                {pending ? 'Replaying…' : 'Replay delivery'}
              </button>
            ) : null}
          </div>
        </>
      ) : (
        <div className="loading-state">Loading history…</div>
      )}
    </Modal>
  );
}
