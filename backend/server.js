// API server. Serves the scan UI + admin dashboard, exposes the scan endpoint,
// and runs the ShipStation sync on a schedule.
const { loadEnv } = require('./env');
loadEnv();

const express = require('express');
const cron = require('node-cron');
const path = require('path');
const { pool, init } = require('./db');
const { syncOnce } = require('./sync');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

const PORT = parseInt(process.env.PORT || '3000', 10);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme';
const SYNC_MINUTES = parseInt(process.env.SYNC_INTERVAL_MINUTES || '25', 10);

// ---- helpers -------------------------------------------------------------

function normalizeItems(items) {
  // Sort so two scans of the same order compare equal regardless of ordering.
  const list = [...items].sort((a, b) =>
    (a.sku + a.name).localeCompare(b.sku + b.name)
  );
  const signature = list.map((i) => `${i.sku}|${i.name}|${i.qty}`).join('||');
  return { list, signature };
}

async function getOrder(tracking) {
  const r = await pool.query('SELECT * FROM orders WHERE tracking_number = $1', [
    tracking,
  ]);
  return r.rows[0] || null;
}

async function getScans(tracking) {
  const r = await pool.query(
    'SELECT * FROM scans WHERE tracking_number = $1 ORDER BY scanned_at ASC',
    [tracking]
  );
  return r.rows;
}

async function insertScan(tracking, user, status, isFirst, detail, at) {
  await pool.query(
    `INSERT INTO scans
       (tracking_number, scanned_by, status, is_first_scan, detail, scanned_at)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [tracking, user, status, isFirst, detail, at]
  );
}

// ---- scan endpoint (user side) ------------------------------------------

app.post('/api/scan', async (req, res) => {
  try {
    const tracking = String(req.body.tracking || '').trim();
    const user = String(req.body.user || 'unknown').trim();
    if (!tracking) return res.status(400).json({ error: 'Tracking required' });

    const order = await getOrder(tracking);
    const now = new Date().toISOString();

    if (!order) {
      await insertScan(tracking, user, 'not_found', 0, null, now);
      return res.json({
        status: 'not_found',
        tracking,
        message:
          'Tracking not found. It may not be synced yet — wait for the next refresh or check the number.',
      });
    }

    const items = JSON.parse(order.items_json || '[]');
    const { list, signature } = normalizeItems(items);

    const priorScans = await getScans(tracking);
    const isFirst = priorScans.length === 0;

    const payload = {
      tracking,
      channel: order.channel,
      order_number: order.order_number,
      ship_to_name: order.ship_to_name,
      ship_to_addr: order.ship_to_addr,
      items: list,
    };

    if (isFirst) {
      await insertScan(tracking, user, 'ok', 1, JSON.stringify({ signature }), now);
      return res.json({ status: 'ok', first_scan: true, ...payload });
    }

    const firstScan = priorScans[0];
    let firstSig = null;
    try {
      firstSig = JSON.parse(firstScan.detail || '{}').signature;
    } catch (_) {}

    const match = firstSig === signature;

    if (match) {
      await insertScan(tracking, user, 'ok', 0, JSON.stringify({ signature }), now);
      return res.json({
        status: 'ok',
        first_scan: false,
        rescan_match: true,
        message: 'Already scanned. Products match the first scan.',
        first_scanned_at: firstScan.scanned_at,
        first_scanned_by: firstScan.scanned_by,
        ...payload,
      });
    }

    await insertScan(
      tracking,
      user,
      'mismatch',
      0,
      JSON.stringify({ first: firstSig, now: signature }),
      now
    );
    return res.json({
      status: 'mismatch',
      first_scan: false,
      rescan_match: false,
      message:
        'MISMATCH: products/quantities differ from the first scan. Do not ship.',
      first_scanned_at: firstScan.scanned_at,
      first_scanned_by: firstScan.scanned_by,
      ...payload,
    });
  } catch (e) {
    console.error('scan error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ---- admin API ----------------------------------------------------------

function checkAdmin(req, res, next) {
  const pw = req.headers['x-admin-password'];
  if (pw !== ADMIN_PASSWORD)
    return res.status(401).json({ error: 'Unauthorized' });
  next();
}

app.get('/api/admin/orders', checkAdmin, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT o.tracking_number, o.order_number, o.channel, o.ship_to_name,
             o.items_json, o.ship_date,
             (SELECT COUNT(*) FROM scans s WHERE s.tracking_number = o.tracking_number) AS scan_count,
             (SELECT status FROM scans s WHERE s.tracking_number = o.tracking_number ORDER BY s.scanned_at DESC LIMIT 1) AS last_status,
             (SELECT scanned_by FROM scans s WHERE s.tracking_number = o.tracking_number ORDER BY s.scanned_at DESC LIMIT 1) AS last_by,
             (SELECT scanned_at FROM scans s WHERE s.tracking_number = o.tracking_number ORDER BY s.scanned_at DESC LIMIT 1) AS last_at
      FROM orders o
      ORDER BY o.ship_date DESC, o.updated_at DESC
      LIMIT 10000
    `);

    const orders = r.rows.map((row) => {
      const items = JSON.parse(row.items_json || '[]');
      const scanCount = parseInt(row.scan_count, 10);
      return {
        tracking_number: row.tracking_number,
        order_number: row.order_number,
        channel: row.channel,
        ship_to_name: row.ship_to_name,
        item_count: items.reduce((s, i) => s + (i.qty || 0), 0),
        ship_date: row.ship_date,
        scan_count: scanCount,
        check_status:
          scanCount === 0
            ? 'pending'
            : row.last_status === 'mismatch'
            ? 'mismatch'
            : 'checked',
        last_by: row.last_by,
        last_at: row.last_at,
      };
    });

    const metaR = await pool.query("SELECT value FROM meta WHERE key = 'last_sync'");
    const lastSync = metaR.rows[0]?.value || null;

    res.json({
      last_sync: lastSync,
      total: orders.length,
      pending: orders.filter((o) => o.check_status === 'pending').length,
      checked: orders.filter((o) => o.check_status === 'checked').length,
      mismatch: orders.filter((o) => o.check_status === 'mismatch').length,
      orders,
    });
  } catch (e) {
    console.error('admin orders error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/admin/scans/:tracking', checkAdmin, async (req, res) => {
  try {
    res.json({ scans: await getScans(req.params.tracking) });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/admin/sync', checkAdmin, async (req, res) => {
  try {
    const result = await syncOnce();
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

// ---- start --------------------------------------------------------------

async function start() {
  await init();

  app.listen(PORT, () => {
    console.log(`ShipScan running on port ${PORT}`);
    console.log(`  Scan UI:   /`);
    console.log(`  Admin:     /admin.html`);

    syncOnce().catch((e) => console.error('Initial sync failed:', e.message));
    const cronExpr = `*/${SYNC_MINUTES} * * * *`;
    cron.schedule(cronExpr, () => {
      console.log('Scheduled sync triggered.');
      syncOnce().catch((e) => console.error('Sync failed:', e.message));
    });
    console.log(`Auto-sync scheduled every ${SYNC_MINUTES} min ("${cronExpr}").`);
  });
}

start().catch((e) => {
  console.error('Startup failed:', e);
  process.exit(1);
});
