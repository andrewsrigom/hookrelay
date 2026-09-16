import { afterEach, describe, expect, it } from 'vitest';
import { harness } from './helpers.js';
import {
  kinds,
  type Delivery,
  type Endpoint,
  type Job,
  type RelayEvent,
} from '../packages/core/model.js';

const open: ReturnType<typeof harness>[] = [];

function setup() {
  const h = harness();
  open.push(h);
  return h;
}

afterEach(() => {
  open.splice(0).forEach((h) => h.store.close());
});

describe('event acceptance', () => {
  it('commits event, independent deliveries and queue intent together', async () => {
    const h = setup();
    await h.relay.createEndpoint({
      name: 'All events',
      url: 'https://example.com/a',
      eventTypes: ['*'],
    });
    await h.publish();
    expect(await h.store.list<RelayEvent>(kinds.event)).toHaveLength(1);
    const deliveries = await h.store.list<Delivery>(kinds.delivery);
    expect(deliveries).toHaveLength(2);
    expect(new Set(deliveries.map((d) => d.endpointId)).size).toBe(2);
    expect(await h.store.list<Job>(kinds.job)).toHaveLength(2);
  });
  it('accepts 25 concurrent publications of one event without duplicate deliveries', async () => {
    const h = setup();
    await h.publish();
    const results = await Promise.all(
      Array.from({ length: 25 }, () =>
        h.relay.publish({ id: 'evt_race', type: 'order.confirmed', data: { x: 1 } }),
      ),
    );
    expect(results.filter((result) => !result.duplicate)).toHaveLength(1);
    expect(await h.store.list<Delivery>(kinds.delivery)).toHaveLength(2);
  });
  it('treats different object key order as the same event', async () => {
    const h = setup();
    await h.relay.publish({
      id: 'evt_order',
      type: 'order.confirmed',
      data: { a: 1, b: { c: 3, d: 4 } },
    });
    expect(
      (
        await h.relay.publish({
          id: 'evt_order',
          type: 'order.confirmed',
          data: { b: { d: 4, c: 3 }, a: 1 },
        })
      ).duplicate,
    ).toBe(true);
  });
  it('rejects reuse of an event ID with changed content', async () => {
    const h = setup();
    await h.publish();
    await expect(
      h.relay.publish({ id: 'evt_test', type: 'order.confirmed', data: { changed: true } }),
    ).rejects.toMatchObject({ status: 409 });
  });
  it('records events with no subscribed destinations and skips paused endpoints', async () => {
    const h = setup();
    const { delivery } = await h.publish();
    await h.relay.setEndpointActive(delivery.endpointId, false);
    const result = await h.relay.publish({ type: 'order.confirmed', data: {} });
    expect(result.event.deliveryIds).toEqual([]);
    expect(
      (await h.relay.publish({ type: 'fulfillment.shipped', data: {} })).event.deliveryIds,
    ).toEqual([]);
  });
  it('encrypts the signing secret and only returns plaintext once', async () => {
    const h = setup();
    const result = await h.relay.createEndpoint({
      name: 'Secure endpoint',
      url: 'https://example.com/hook',
      eventTypes: ['*'],
    });
    const stored = await h.store.get<Endpoint>(kinds.endpoint, result.endpoint.id);
    expect(JSON.stringify(stored)).not.toContain(result.signingSecret);
    expect(result.endpoint).not.toHaveProperty('encryptedSecret');
  });
  it('enforces the workspace size even when registrations race', async () => {
    const h = setup();

    for (let i = 0; i < 19; i++) {
      await h.relay.createEndpoint({
        name: `Endpoint ${i}`,
        url: 'https://example.com/hook',
        eventTypes: ['*'],
      });
    }

    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        h.relay.createEndpoint({
          name: 'Concurrent endpoint',
          url: 'https://example.com/hook',
          eventTypes: ['*'],
        }),
      ),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(await h.store.list<Endpoint>(kinds.endpoint, 30)).toHaveLength(20);
  });
  it('rejects arrays, invalid IDs and oversized payloads', async () => {
    const h = setup();
    await expect(h.relay.publish({ type: 'order.confirmed', data: [] })).rejects.toThrow();
    await expect(
      h.relay.publish({ id: '../path', type: 'order.confirmed', data: {} }),
    ).rejects.toThrow();
    await expect(
      h.relay.publish({ type: 'order.confirmed', data: { text: 'x'.repeat(33000) } }),
    ).rejects.toMatchObject({ status: 413 });
  });
});
