// Postgres connection pool + schema bootstrap.
// Uses DATABASE_URL (provided automatically by Railway when you add Postgres).
const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;

const pool = new Pool({
  connectionString,
  // Railway/most managed Postgres require SSL. Local dev without SSL is allowed.
  ssl:
    process.env.PGSSL === 'disable'
      ? false
      : connectionString && connectionString.includes('localhost')
      ? false
      : { rejectUnauthorized: false },
});

// Create tables once on startup.
async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      tracking_number TEXT PRIMARY KEY,
      order_number    TEXT,
      channel         TEXT,
      ship_to_name    TEXT,
      ship_to_addr    TEXT,
      items_json      TEXT,
      order_date      TEXT,
      ship_date       TEXT,
      updated_at      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_orders_channel ON orders(channel);

    CREATE TABLE IF NOT EXISTS scans (
      id              SERIAL PRIMARY KEY,
      tracking_number TEXT,
      scanned_by      TEXT,
      status          TEXT,
      is_first_scan   INTEGER,
      detail          TEXT,
      scanned_at      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_scans_tracking ON scans(tracking_number);

    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT
    );
  `);
  console.log('Database ready.');
}

module.exports = { pool, init };
