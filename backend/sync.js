// Pulls SHIPPED orders from ShipStation V1 API into Postgres.
//
// INCREMENTAL: instead of re-pulling a fixed number of days every run (which
// wastes API calls and hits the rate limit), it remembers the timestamp of the
// last successful sync (a "watermark") and only asks ShipStation for shipments
// CREATED since then. So each run grabs just the new shipments, not yesterday's
// again. The very first run (no watermark yet) pulls a small starting backlog.
const { loadEnv } = require('./env');
loadEnv();
const { pool } = require('./db');

const API_KEY = process.env.SHIPSTATION_API_KEY;
const API_SECRET = process.env.SHIPSTATION_API_SECRET;

// Used ONLY for the very first sync when there is no watermark yet.
const FIRST_RUN_BACKLOG_DAYS = parseInt(
  process.env.FIRST_RUN_BACKLOG_DAYS || '2',
  10
);
// A small safety overlap so nothing slips through the cracks between runs
// (e.g. a shipment recorded a few seconds before the watermark). Re-pulling a
// tiny overlap is cheap and just harmlessly updates existing rows.
const OVERLAP_MINUTES = parseInt(process.env.SYNC_OVERLAP_MINUTES || '10', 10);

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

// ShipStation expects "YYYY-MM-DD HH:MM:SS" (its account timezone). We store the
// watermark in UTC and format consistently; the small overlap covers any skew.
function fmt(d) {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

function daysAgo(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d;
}

async function getWatermark() {
  const r = await pool.query("SELECT value FROM meta WHERE key = 'sync_watermark'");
  return r.rows[0]?.value || null;
}

async function setWatermark(iso) {
  await pool.query(
    `INSERT INTO meta(key, value) VALUES('sync_watermark', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [iso]
  );
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
  // This run will only pull shipments RECORDED after `since`.
  const runStartedAt = new Date();

  const watermark = await getWatermark();
  let since;
  if (watermark) {
    // Incremental: from last successful sync, minus a small overlap.
    const wm = new Date(watermark);
    wm.setMinutes(wm.getMinutes() - OVERLAP_MINUTES);
    since = wm;
    console.log(`Incremental sync. New shipments since ${fmt(since)} (watermark ${watermark}).`);
  } else {
    // First ever run: pull a small starting backlog.
    since = daysAgo(FIRST_RUN_BACKLOG_DAYS);
    console.log(`First sync. Pulling last ${FIRST_RUN_BACKLOG_DAYS} day(s): since ${fmt(since)}.`);
  }

  const createDateStart = fmt(since);
  const orderCache = new Map();
  let page = 1;
  let pages = 1;
  let count = 0;

  do {
    // createDateStart = when ShipStation RECORDED the shipment. This is the key
    // to incremental pulls: we only get shipments new since our last sync,
    // never re-pulling the whole history each time.
    const url =
      `${BASE}/shipments?createDateStart=${encodeURIComponent(createDateStart)}` +
      `&includeShipmentItems=true&pageSize=500&page=${page}&sortBy=CreateDate&sortDir=ASC`;
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

  // Advance the watermark to when THIS run started, so the next run picks up
  // from here. (We use run start, not run end, so shipments recorded during a
  // long sync aren't skipped — the overlap covers the rest.)
  await setWatermark(runStartedAt.toISOString());

  // Keep the human-facing "last_sync" for the dashboard header.
  await pool.query(
    `INSERT INTO meta(key, value) VALUES('last_sync', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [new Date().toISOString()]
  );

  // Remove orders older than the retention window (keeps the DB tidy and the
  // dashboard count real). Scan history is NOT touched here — see cleanup.js.
  const removed = await cleanupOldOrders();

  const secs = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`Sync done. ${count} new/updated shipments in ${secs}s. Cleaned ${removed} old orders.`);
  return { synced: count, cleaned: removed };
}

// Delete orders whose ship_date is older than RETENTION_DAYS. Scan records are
// preserved (audit trail is permanent). An order re-scanned within the window
// still has its data, so the mismatch check keeps working.
const RETENTION_DAYS = parseInt(process.env.RETENTION_DAYS || '10', 10);

async function cleanupOldOrders() {
  const cutoff = daysAgo(RETENTION_DAYS);
  const cutoffStr = cutoff.toISOString().slice(0, 10); // YYYY-MM-DD
  // ship_date from ShipStation is like "2026-07-31T..." or "2026-07-31"; compare
  // on the date prefix. Orders with no ship_date are left alone.
  const r = await pool.query(
    `DELETE FROM orders
     WHERE ship_date IS NOT NULL
       AND ship_date <> ''
       AND substr(ship_date, 1, 10) < $1`,
    [cutoffStr]
  );
  return r.rowCount || 0;
}

module.exports = { syncOnce, cleanupOldOrders };

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
