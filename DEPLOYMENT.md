# TFNN Deployment Runbook

## Standard deploy sequence (every time)
1. **Schema first** — append any new `schema_additions_*.sql` content to the bottom of `sql/schema.sql`
2. **Route/utility files** — full replace (select-all → delete → paste), never partial edits
3. **`src/index.js`** — confirm any new route is both `require`'d near the top AND has an `app.use(...)` line, placed *before* the catch-all 404 handler
4. **New env vars** (API keys, secrets) — set in Render's Environment tab first, before the code that needs them goes live
5. **Migrate**: Render → Start Command → `npm run migrate && npm start` → Save (triggers redeploy) → watch logs for `Done. Tables created (or already existed)` with no errors
6. **Revert** Start Command back to `npm start` → Save

## Testing a migration safely (recommended before any schema change that worries you)
See the branch-based process above — Neon branch → point Render at it temporarily → verify migrate succeeds → point back at production → migrate for real.

## Pre-deploy checklist for this session's backlog
Schema fragments that must all be present, in this order, at the bottom of `sql/schema.sql`:
- [ ] `client_id` idempotency columns (animal, animal_event, sale, expense, task, media, marketplace_listing)
- [ ] `approved` column on `users` (account approval gate)
- [ ] `district` column on `users` + `district_alert` table
- [ ] `sale` table + `estimated_value` on `animal` + `deleted_at` on `expense`
- [ ] `ref_type`/`ref_id` on `task` (auto-generated reminders)
- [ ] `media` table (photos/voice notes)
- [ ] `marketplace_listing` table
- [ ] `email` column on `users` + `notification` table + `push_subscription` table

Route files that must be both created/replaced AND mounted in `index.js`:
- [ ] `sales.js`, `expenses.js`, `valuation.js`, `statement.js`, `media.js`, `marketplace.js` (was previously mounted in the wrong place — must be above the 404 handler)
- [ ] `users.js`, `market.js`, `alerts.js`, `notifications.js`

Env vars that must be set in Render:
- [ ] `RESEND_API_KEY`
- [ ] `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY`

Frontend files (GitHub Pages, same folder as `app.html`):
- [ ] `app.html` (latest version — includes offline sync, media capture, marketplace, spreadsheet import, notifications)
- [ ] `manifest.json`, `sw.js`, `icon-192.png`, `icon-512.png`

## Known open items
- `src/migrate.js` was never reviewed — if CI (`.github/workflows/test.yml`) fails, this is the first place to check (may need a `postgresql-client` install step if it shells out to `psql`)
- NamLITS direct import (vs. the general spreadsheet importer) is still pending a sample export file
