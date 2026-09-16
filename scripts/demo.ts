export {};

const origin = process.env['HOOKRELAY_API_URL'] ?? 'http://127.0.0.1:4310';

const id = `evt_${crypto.randomUUID()}`;

const body = JSON.stringify({
  id,
  type: 'order.confirmed',
  data: {
    orderId: 'ord_1042',
    currency: 'BRL',
    totalMinor: 15990,
    items: [{ sku: 'SKU-101', quantity: 2 }],
  },
});

const headers = {
  'Content-Type': 'application/json',
  ...(process.env['HOOKRELAY_API_KEY']
    ? { Authorization: `Bearer ${process.env['HOOKRELAY_API_KEY']}` }
    : {}),
};

for (let delivery = 0; delivery < 2; delivery++) {
  const response = await fetch(`${origin}/api/events`, { method: 'POST', headers, body });
  const result = await response.json();

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${JSON.stringify(result)}`);
  }

  console.log(
    `${delivery === 0 ? 'Publication' : 'Repeat with the same ID'}: HTTP ${response.status}`,
  );
  console.log(JSON.stringify(result, null, 2));
}

console.log('Open the dashboard to inspect the deliveries and recipient responses.');
