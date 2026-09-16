import { ArrowUpRight, ArrowRight, Search } from 'lucide-react';
import { useState } from 'react';
import type { Delivery } from '../../../../packages/core/model.js';
import { dateTime, Empty, shortId, StatusBadge } from './ui.js';

export function DeliveryTable({
  deliveries,
  onSelect,
  compact = false,
  onViewAll,
}: {
  deliveries: Delivery[];
  onSelect: (id: string) => void;
  compact?: boolean;
  onViewAll?: () => void;
}) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('all');
  const filtered = deliveries.filter(
    (delivery) =>
      (status === 'all' || delivery.status === status) &&
      `${delivery.id} ${delivery.eventId} ${delivery.eventType} ${delivery.endpointName}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const rows = compact ? filtered.slice(0, 6) : filtered;

  return (
    <section className="panel delivery-panel">
      <div className="panel-heading">
        <div>
          <h2>{compact ? 'Recent deliveries' : 'Delivery history'}</h2>
          {!compact ? <p>Latest 200 deliveries and their attempts.</p> : null}
        </div>
        {compact ? (
          <button className="text-button" onClick={onViewAll}>
            View all <ArrowRight size={15} />
          </button>
        ) : (
          <span className="count-pill">
            {filtered.length} {filtered.length === 1 ? 'delivery' : 'deliveries'}
          </span>
        )}
      </div>
      {!compact ? (
        <div className="table-tools">
          <label className="search">
            <Search size={17} />
            <input
              aria-label="Search deliveries"
              placeholder="Search by event, endpoint, or ID…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <select
            aria-label="Filter by status"
            value={status}
            onChange={(event) => setStatus(event.target.value)}
          >
            <option value="all">All statuses</option>
            <option value="delivered">Delivered</option>
            <option value="retrying">Retrying</option>
            <option value="failed">Failed</option>
            <option value="queued">Queued</option>
            <option value="processing">Sending</option>
          </select>
        </div>
      ) : null}
      {rows.length ? (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Event / delivery</th>
                <th>Endpoint</th>
                <th>Status</th>
                <th>Attempts</th>
                <th>Created</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((delivery) => (
                <tr key={delivery.id}>
                  <td>
                    <button className="event-link" onClick={() => onSelect(delivery.id)}>
                      {delivery.eventType}
                    </button>
                    <span className="mono table-id">{shortId(delivery.id)}</span>
                    <span className="mobile-status" aria-hidden="true">
                      <StatusBadge status={delivery.status} />
                    </span>
                  </td>
                  <td>
                    <span className="destination-name">
                      <span className="destination-dot" />
                      {delivery.endpointName}
                    </span>
                  </td>
                  <td>
                    <StatusBadge status={delivery.status} />
                  </td>
                  <td className="mono attempts-cell">
                    {delivery.attemptCount}
                    <span> / 5</span>
                  </td>
                  <td className="date-cell">{dateTime(delivery.createdAt)}</td>
                  <td>
                    <button
                      className="icon-button"
                      aria-label={`View delivery ${delivery.id}`}
                      onClick={() => onSelect(delivery.id)}
                    >
                      <ArrowUpRight size={17} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty
          title={query || status !== 'all' ? 'No matching deliveries' : 'No deliveries yet'}
          description={
            query || status !== 'all'
              ? 'Change the search or status filter.'
              : 'Publish an event to create deliveries.'
          }
        />
      )}
    </section>
  );
}
