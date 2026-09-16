import { Radio, CheckCheck, RotateCw, TriangleAlert } from 'lucide-react';
import type { OverviewData } from '../api.js';
import { DeliveryTable } from './DeliveryTable.js';

function ActivityChart({ data }: { data: OverviewData }) {
  const bucketMs = 5 * 60000;
  const end = Math.floor(data.now / bucketMs) * bucketMs;
  const buckets = Array.from({ length: 12 }, (_, index) => {
    const start = end - (11 - index) * bucketMs;
    const deliveries = data.deliveries.filter(
      (delivery) => delivery.createdAt >= start && delivery.createdAt < start + bucketMs,
    );
    return {
      delivered: deliveries.filter((delivery) => delivery.status === 'delivered').length,
      other: deliveries.filter((delivery) => delivery.status !== 'delivered').length,
    };
  });
  const max = Math.max(1, ...buckets.map((bucket) => bucket.delivered + bucket.other));

  return (
    <div
      className="activity-chart"
      role="img"
      aria-label={`Past-hour activity from the latest ${data.scope.deliveries} deliveries, grouped into five-minute intervals`}
    >
      <div className="chart-grid">
        <span>{max}</span>
        <span>{max > 1 ? Math.round(max / 2) : 0.5}</span>
        <span>0</span>
      </div>
      <div className="chart-bars">
        {buckets.map((bucket, index) => (
          <div
            className="chart-column"
            key={index}
            title={`${bucket.delivered} delivered, ${bucket.other} other`}
          >
            <div className="bar-other" style={{ height: `${(bucket.other / max) * 100}%` }} />
            <div className="bar-success" style={{ height: `${(bucket.delivered / max) * 100}%` }} />
          </div>
        ))}
      </div>
      <div className="chart-axis">
        <span>60 min ago</span>
        <span>30 min</span>
        <span>Now</span>
      </div>
    </div>
  );
}

export function Overview({
  data,
  onSelect,
  onViewAll,
}: {
  data: OverviewData;
  onSelect: (id: string) => void;
  onViewAll: () => void;
}) {
  const success = data.deliveries.filter((delivery) => delivery.status === 'delivered').length;
  const retrying = data.deliveries.filter(
    (delivery) =>
      delivery.status === 'retrying' ||
      delivery.status === 'processing' ||
      delivery.status === 'queued',
  ).length;
  const failed = data.deliveries.filter((delivery) => delivery.status === 'failed').length;
  const hasRecentActivity = data.deliveries.some(
    (delivery) => delivery.createdAt >= data.now - 60 * 60000,
  );
  const percent = data.deliveries.length
    ? ((success / data.deliveries.length) * 100).toFixed(1)
    : '—';
  const stats = [
    {
      label: 'Recent deliveries',
      value: data.deliveries.length,
      note: `Latest ${data.scope.deliveries}`,
      icon: Radio,
      className: '',
    },
    {
      label: 'Delivered',
      value: success,
      note: data.deliveries.length ? `${percent}% of recent deliveries` : 'No deliveries yet',
      icon: CheckCheck,
      className: 'green',
    },
    {
      label: 'In progress',
      value: retrying,
      note: 'Queued or retrying',
      icon: RotateCw,
      className: 'amber',
    },
    {
      label: 'Failed',
      value: failed,
      note: 'Eligible for replay',
      icon: TriangleAlert,
      className: 'red',
    },
  ];

  return (
    <>
      <div className="stats-grid">
        {stats.map((stat) => (
          <div className="stat-card" key={stat.label}>
            <div className="stat-label">
              {stat.label}
              <stat.icon size={17} className={stat.className} />
            </div>
            <strong>{stat.value}</strong>
            <span className="stat-note">{stat.note}</span>
          </div>
        ))}
      </div>
      <div className="overview-grid">
        <section
          className={hasRecentActivity ? 'panel activity-panel' : 'panel activity-panel quiet'}
        >
          <div className="panel-heading">
            <div>
              <h2>Delivery activity</h2>
            </div>
            <span className="subtle-pill">Past hour · latest {data.scope.deliveries}</span>
          </div>
          {hasRecentActivity ? (
            <>
              <div className="chart-legend">
                <span>
                  <i className="green-dot" />
                  Delivered
                </span>
                <span>
                  <i className="muted-dot" />
                  Other
                </span>
              </div>
              <ActivityChart data={data} />
            </>
          ) : (
            <p className="no-activity">No deliveries in the past hour.</p>
          )}
        </section>
      </div>
      <DeliveryTable
        deliveries={data.deliveries}
        onSelect={onSelect}
        compact
        onViewAll={onViewAll}
      />
    </>
  );
}
