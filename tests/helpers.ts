import { SqliteStore } from '../packages/storage/sqlite-store.js';
import { RelayService } from '../packages/core/relay-service.js';
import { DeliveryWorker, type Transport } from '../packages/core/delivery-worker.js';
import { kinds, type Delivery, type Job } from '../packages/core/model.js';

export const masterKey = 'test-only-master-key-with-at-least-32-characters';

export function harness(transport: Transport = { send: async () => ({ statusCode: 200 }) }) {
  const store = new SqliteStore(':memory:');
  let clock = 1800000000000;
  const now = () => clock;
  const relay = new RelayService({ store, masterKey, validateUrl: async () => {}, now });
  const worker = new DeliveryWorker({ store, masterKey, transport, now });

  return {
    store,
    relay,
    worker,
    now,
    advance: (ms: number) => {
      clock += ms;
    },
    async publish() {
      await relay.createEndpoint({
        name: 'Destination',
        url: 'https://hooks.example.com/receive',
        eventTypes: ['order.confirmed'],
      });
      const { event } = await relay.publish({
        id: 'evt_test',
        type: 'order.confirmed',
        data: { orderId: 'ord_1042' },
      });
      const delivery = (await store.get<Delivery>(kinds.delivery, event.deliveryIds[0]!))!;
      const job = (await store.list<Job>(kinds.job))[0]!;

      return { event, delivery, job };
    },
  };
}
