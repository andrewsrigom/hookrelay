import type { RelayEvent } from './model.js';

/** Shared body for signing, delivery, and inspection. */
export function webhookEnvelope(event: RelayEvent) {
  return {
    id: event.id,
    type: event.type,
    createdAt: new Date(event.createdAt).toISOString(),
    data: event.data,
  };
}
