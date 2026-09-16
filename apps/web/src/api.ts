import type {
  Attempt,
  Delivery,
  PublicEndpoint,
  RelayEvent,
} from '../../../packages/core/model.js';

export interface OverviewData {
  endpoints: PublicEndpoint[];
  deliveries: Delivery[];
  events: Omit<RelayEvent, 'data' | 'fingerprint'>[];
  receiverOrigin?: string;
  now: number;
  scope: { deliveries: number; events: number };
}

export interface DeliveryDetail {
  payload: { id: string; type: string; createdAt: string; data: Record<string, unknown> };
  delivery: Delivery;
  event: Pick<RelayEvent, 'id' | 'type' | 'data' | 'createdAt'>;
  attempts: Attempt[];
}

let accessKey = '';

export function setAccessKey(value: string) {
  accessKey = value;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(
  path: string,
  method = 'GET',
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    signal,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(accessKey ? { Authorization: `Bearer ${accessKey}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await response.json()) as T & {
    error?: string;
    fields?: { path: string; message: string }[];
  };

  if (!response.ok) {
    throw new ApiError(
      response.status,
      data.fields?.length
        ? `${data.error} ${data.fields.map((field) => `${field.path}: ${field.message}`).join('; ')}`
        : (data.error ?? 'Request failed.'),
    );
  }

  return data;
}

export function message(error: unknown): string {
  return error instanceof Error ? error.message : 'An error occurred. Try again.';
}
