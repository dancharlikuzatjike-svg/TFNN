# Trying Farmers Network Namibia (TFNN)

TFNN is a farmer-owned livestock management system for cattle, sheep and goats. This repository contains the Express/PostgreSQL API and the responsive farmer portal served from `public/`.

## Local setup

```bash
npm install
cp env.example .env
npm run migrate
npm run dev
```

Open `http://localhost:4000`. Use a test database while developing.

## Checks

```bash
npm test
node --check public/app.js
node --check src/index.js
node --check src/routes/animals.js
```

## Farmer portal

- Owner-scoped cattle, sheep and goat records
- Species, class, status and breeding-male filters
- Bull/Ram/Buck breeding classification
- Pedigree parent selection and close-relation warnings
- Bulk status updates and CSV/JSON export
- Offline local changes with reconnection sync
- Installable PWA shell

See [`docs/FARMER_PORTAL_GUIDE.md`](docs/FARMER_PORTAL_GUIDE.md) for a beginner-friendly guide to making changes safely.
