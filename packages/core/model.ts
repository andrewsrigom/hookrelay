/** Stored records have a version for optimistic concurrency and an immutable creation time. */
export interface RecordBase {
  id: string;
  version: number;
  createdAt: number;
}

export interface Endpoint extends RecordBase {
  name: string;
  url: string;
  eventTypes: string[];
  active: boolean;
  encryptedSecret: string;
}

export type PublicEndpoint = Omit<Endpoint, 'encryptedSecret'>;

export interface RelayEvent extends RecordBase {
  type: string;
  data: Record<string, unknown>;
  fingerprint: string;
  deliveryIds: string[];
}

export type DeliveryStatus = 'queued' | 'processing' | 'retrying' | 'delivered' | 'failed';

export interface Delivery extends RecordBase {
  eventId: string;
  eventType: string;
  endpointId: string;
  endpointName: string;
  endpointUrl: string;
  status: DeliveryStatus;
  attemptCount: number;
  nextAttemptAt: number;
  updatedAt: number;
  leaseToken?: string;
  leaseUntil?: number;
  lastStatus?: number;
  lastError?: string;
  completedAt?: number;
  replayOf?: string;
}

export interface Attempt extends RecordBase {
  deliveryId: string;
  number: number;
  startedAt: number;
  durationMs: number;
  outcome: 'success' | 'retry' | 'failed';
  statusCode?: number;
  error?: string;
}

/** An outbox record is committed in the SAME transaction as its delivery state. */
export interface Job extends RecordBase {
  deliveryId: string;
  expectedAttempt: number;
  route: 'delivery' | 'dead-letter';
  availableAt: number;
  acknowledged?: boolean;
  queueLeaseUntil?: number;
  queueLeaseToken?: string;
}

export interface Mutation {
  kind: string;
  value: RecordBase;
  expectedVersion: number | 'absent';
}

export interface Store {
  get<T extends RecordBase>(kind: string, id: string): Promise<T | undefined>;
  list<T extends RecordBase>(kind: string, limit?: number): Promise<T[]>;
  transact(changes: Mutation[]): Promise<void>;
}

export class ConflictError extends Error {
  constructor() {
    super('Concurrent write');
    this.name = 'ConflictError';
  }
}

export class AppError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const kinds = {
  endpoint: 'ENDPOINT',
  event: 'EVENT',
  delivery: 'DELIVERY',
  job: 'OUTBOX',
} as const;

export function attemptKind(deliveryId: string): string {
  return `ATTEMPT#${deliveryId}`;
}

export function publicEndpoint(endpoint: Endpoint): PublicEndpoint {
  const { encryptedSecret: _secret, ...safe } = endpoint;
  return safe;
}
