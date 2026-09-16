import { setTimeout as delay } from 'node:timers/promises';

interface Endpoint {
  id: string;
  active: boolean;
  eventTypes: string[];
}

interface Delivery {
  id: string;
  endpointId: string;
  status: 'queued' | 'processing' | 'retrying' | 'delivered' | 'failed';
  attemptCount: number;
  lastError?: string;
}

interface Overview {
  endpoints: Endpoint[];
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Set ${name} before running the AWS smoke test.`);
  }
  return value;
}

const baseUrl = requiredEnv('HOOKRELAY_API_URL').replace(/\/$/, '');
const apiKey = requiredEnv('HOOKRELAY_API_KEY');
const endpointId = requiredEnv('HOOKRELAY_SMOKE_ENDPOINT_ID');

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  });
  const text = await response.text();
  let body: unknown;

  try {
    body = text ? (JSON.parse(text) as unknown) : undefined;
  } catch {
    body = undefined;
  }

  if (!response.ok) {
    const message =
      body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
        ? body.error
        : `HTTP ${response.status}`;
    throw new Error(`HookRelay request failed: ${message}`);
  }

  return body as T;
}

async function main() {
  const overview = await request<Overview>('/api/overview');
  const endpoint = overview.endpoints.find((candidate) => candidate.id === endpointId);

  if (!endpoint) {
    throw new Error('HOOKRELAY_SMOKE_ENDPOINT_ID does not exist in this deployment.');
  }
  if (!endpoint.active) {
    throw new Error('The smoke-test endpoint is paused.');
  }
  if (!endpoint.eventTypes.includes('*') && !endpoint.eventTypes.includes('hookrelay.smoke')) {
    throw new Error('The smoke-test endpoint must subscribe to hookrelay.smoke or *.');
  }

  const eventId = `evt_smoke_${Date.now()}`;
  const published = await request<{ event: { deliveryIds: string[] } }>('/api/events', {
    method: 'POST',
    body: JSON.stringify({
      id: eventId,
      type: 'hookrelay.smoke',
      data: { source: 'aws-smoke', publishedAt: new Date().toISOString() },
    }),
  });

  if (published.event.deliveryIds.length === 0) {
    throw new Error('The event was accepted without a matching delivery.');
  }

  const deadline = Date.now() + 120_000;
  let lastStatus = 'queued';

  while (Date.now() < deadline) {
    const deliveries = await Promise.all(
      published.event.deliveryIds.map((id) =>
        request<{ delivery: Delivery }>(`/api/deliveries/${id}`),
      ),
    );
    const target = deliveries.find((item) => item.delivery.endpointId === endpointId)?.delivery;

    if (target) {
      lastStatus = target.status;
      if (target.status === 'delivered') {
        console.log(
          `AWS smoke test passed: ${eventId} delivered in ${target.attemptCount} attempt(s).`,
        );
        return;
      }
      if (target.status === 'failed') {
        throw new Error(`AWS smoke delivery failed: ${target.lastError ?? 'unknown error'}`);
      }
    }

    await delay(2_000);
  }

  throw new Error(`AWS smoke test timed out with status ${lastStatus}.`);
}

await main();
