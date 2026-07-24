# ShipScan — ShipStation shipped-order scan verification

A warehouse pick-verification system. It pulls **shipped orders from ShipStation
on a schedule** (so it never hits the API rate limit during scanning), stores
them in a database, and lets any phone or tablet **scan a tracking number** to
instantly see the products, quantities, and channel — with the address and order
number below. Re-scanning the same tracking re-checks the products and flags any
mismatch. An admin dashboard shows which trackings are checked vs pending.

## Deploying to the cloud

**See `DEPLOY-RAILWAY.md` for full step-by-step cloud deployment.** That's the
recommended way to run this: your own server in the cloud, reachable from
anywhere, HTTPS included, handles multiple simultaneous users. No hardware.

## What it does

- **Background sync** — every 20–30 min (configurable) it pulls shipped orders
  from ShipStation into Postgres. Respects the ShipStation rate limit (waits
  when remaining requests get low, backs off on 429).
- **Fast scan** — the scan endpoint only reads the local database, so results
  are instant regardless of ShipStation limits, even with many users at once.
- **Scan screen** (`/`) — works on any mobile/tablet browser. Camera barcode
  scanning or manual entry. Shows: **channel + product names + qty on top**,
  then **address + order number** below.
- **Duplicate handling** — first scan is recorded and shown as verified. A second
  scan of the same tracking shows the first-scan result again and compares
  products/qty. Match → "already scanned, match". Mismatch → red error.
- **Admin dashboard** (`/admin.html`) — password-protected. Shows every shipped
  order with status **pending / checked / mismatch**, who scanned it, and when.
  Search + filter by channel/status. Manual "Sync now" button.

## Settings (environment variables)

| Key | Meaning |
|-----|---------|
| `DATABASE_URL` | Postgres connection (set automatically by Railway) |
| `SHIPSTATION_API_KEY` / `SHIPSTATION_API_SECRET` | ShipStation V1 API creds |
| `SYNC_INTERVAL_MINUTES` | How often to refresh shipped orders (default 25) |
| `SYNC_LOOKBACK_DAYS` | How far back to pull shipped orders (default 14) |
| `ADMIN_PASSWORD` | Password for the admin dashboard |
| `PORT` | Server port (set automatically by Railway) |

## How duplicate / mismatch logic works

On the **first** scan of a tracking, the current product+qty list is saved as a
signature. On any **later** scan, the stored order's current signature is
compared to that first signature:
- **Same** → status `ok`, "already scanned, products match".
- **Different** → status `mismatch`, red "do not ship" banner. Catches cases
  where the order was edited/re-shipped after the first check.

Every scan (including not-found) is logged with the user/station name and time,
which is what the admin dashboard reads.

## Files

```
backend/
  server.js   Express API + cron scheduler + static hosting (Postgres)
  sync.js     ShipStation pull (rate-limit aware). Also runnable: `npm run sync`
  db.js       Postgres pool + schema (orders, scans, meta)
  env.js      tiny .env loader (for local dev)
public/
  index.html  scan screen (mobile/tablet)
  admin.html  admin dashboard
railway.json  Railway deploy config
Procfile      start command (Railway/Render/etc.)
DEPLOY-RAILWAY.md   step-by-step cloud deployment guide
```

## Running locally (optional, for testing)

You need a local Postgres and a `.env` file (copy `.env.example`). Then:

```bash
npm install
npm start
```

Scan screen: `http://localhost:3000/` · Admin: `http://localhost:3000/admin.html`

## Notes / possible next steps

- Add per-user login instead of a shared station name.
- Physical pack-confirmation mode: item checkboxes on the scan screen so packers
  confirm actual box contents against the order.
