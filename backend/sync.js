// Pulls SHIPPED orders from ShipStation V1 API and upserts them into Postgres.
// Runs on an interval so the user-facing scan endpoint is fast and never hits
// the ShipStation rate limit directly.
const { loadEnv } = require('./env');
loadEnv();
const { pool } = require('./db');

const API_KEY = process.env.SHIPSTATION_API_KEY;
const API_SECRET = process.env.SHIPSTATION_API_SECRET;
const LOOKBACK_DAYS = parseInt(process.env.SYNC_LOOKBACK_DAYS || '14', 10);

const BASE = 'https://ssapi.shipstation.com';

function authHeader() {
  const token = Buffer.from(`${API_KEY}:${API_SECRET}`).toString('base64');
  return `Basic ${token}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ShipStation V1 rate limit = 40 requests / minute. We read the reset header
// and sleep when we get close, so a sync never trips the limit.
async function ssFetch(url) {
  while (true) {
    const res = await fetch(url, { headers: { Authorization: authHeader() } });

    if (res.status === 429) {
      const wait = parseInt(res.headers.get('X-Rate-Limit-Reset') || '60', 10);
      console.log(`Rate limited. Waiting ${wait}s...`);
      await sleep((wait + 1) * 1000);
      continue;
    }
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`ShipStation ${res.status}: ${body}`);
    }

    const remaining = parseInt(res.headers.get('X-Rate-Limit-Remaining') || '40', 10);
    const reset = parseInt(res.headers.get('X-Rate-Limit-Reset') || '0', 10);
    if (remaining <= 2 && reset > 0) {
      console.log(`Approaching rate limit. Cooling down ${reset}s...`);
      await sleep((reset + 1) * 1000);
    }
    return res.json();
  }
}

function isoDaysAgo(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

function mapOrder(o) {
  const items = (o.items || [])
    .filter((it) => !it.adjustment)
    .map((it) => ({
      name: it.name || it.sku || 'Unknown item',
      sku: it.sku || '',
      qty: it.quantity || 0,
    }));

  const s = o.shipTo || {};
  const addrParts = [
    s.name,
    s.company,
    s.street1,
    s.street2,
    s.street3,
    [s.city, s.state, s.postalCode].filter(Boolean).join(', '),
    s.country,
  ].filter(Boolean);

  return {
    order_number: o.orderNumber || '',
    channel: o.advancedOptions?.source || o.orderSource || 'Manual',
    ship_to_name: s.name || '',
    ship_to_addr: addrParts.join('\n'),
    items_json: JSON.stringify(items),
    order_date: o.orderDate || '',
    ship_date: o.shipDate || '',
  };
}

const UPSERT_SQL = `
  INSERT INTO orders
    (tracking_number, order_number, channel, ship_to_name, ship_to_addr,
     items_json, order_date, ship_date, updated_at)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
  ON CONFLICT (tracking_number) DO UPDATE SET
    order_number = EXCLUDED.order_number,
    channel      = EXCLUDED.channel,
    ship_to_name = EXCLUDED.ship_to_name,
    ship_to_addr = EXCLUDED.ship_to_addr,
    items_json   = EXCLUDED.items_json,
    order_date   = EXCLUDED.order_date,
    ship_date    = EXCLUDED.ship_date,
    updated_at   = EXCLUDED.updated_at
`;

async function upsertOrder(tracking, row) {
  await pool.query(UPSERT_SQL, [
    tracking,
    row.order_number,
    row.channel,
    row.ship_to_name,
    row.ship_to_addr,
    row.items_json,
    row.order_date,
    row.ship_date,
    new Date().toISOString(),
  ]);
}

async function syncOnce() {
  if (!API_KEY || !API_SECRET || API_KEY === 'your_api_key_here') {
    console.warn('ShipStation credentials not set. Skipping sync. (See env vars)');
    return { synced: 0, skipped: true };
  }

  const start = Date.now();
  const shipDateStart = isoDaysAgo(LOOKBACK_DAYS);
  console.log(`Sync started. Shipments since ${shipDateStart}...`);

  const orderCache = new Map();
  let page = 1;
  let pages = 1;
  let count = 0;

  do {
    const url =
      `${BASE}/shipments?shipDateStart=${encodeURIComponent(shipDateStart)}` +
      `&includeShipmentItems=true&pageSize=500&page=${page}`;
    const data = await ssFetch(url);
    pages = data.pages || 1;

    for (const shp of data.shipments || []) {
      if (shp.voided) continue;
      const tracking = shp.trackingNumber;
      if (!tracking) continue;

      let order = orderCache.get(shp.orderId);
      if (!order && shp.orderId) {
        try {
          order = await ssFetch(`${BASE}/orders/${shp.orderId}`);
          orderCache.set(shp.orderId, order);
        } catch (e) {
          console.warn(`Order ${shp.orderId} fetch failed: ${e.message}`);
        }
      }

      const row = order
        ? mapOrder(order)
        : {
            order_number: shp.orderNumber || '',
            channel: 'Manual',
            ship_to_name: shp.shipTo?.name || '',
            ship_to_addr: [
              shp.shipTo?.name,
              shp.shipTo?.street1,
              [shp.shipTo?.city, shp.shipTo?.state, shp.shipTo?.postalCode]
                .filter(Boolean)
                .join(', '),
            ]
              .filter(Boolean)
              .join('\n'),
            items_json: JSON.stringify(
              (shp.shipmentItems || []).map((it) => ({
                name: it.name || it.sku,
                sku: it.sku || '',
                qty: it.quantity || 0,
              }))
            ),
            order_date: '',
            ship_date: shp.shipDate || '',
          };

      await upsertOrder(tracking.trim(), row);
      count++;
    }
    page++;
  } while (page <= pages);

  await pool.query(
    `INSERT INTO meta(key, value) VALUES('last_sync', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [new Date().toISOString()]
  );

  const secs = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`Sync done. ${count} shipments upserted in ${secs}s.`);
  return { synced: count };
}

module.exports = { syncOnce };

if (require.main === module) {
  const { init } = require('./db');
  init()
    .then(() => syncOnce())
    .then(() => process.exit(0))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
