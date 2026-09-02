# Ferry Tracker

A local Phase 0 explorer for Washington State Ferries terminal, vessel, and schedule data.

## Run the POC

```powershell
npm install
npm run dev
```

Open `http://127.0.0.1:5173`. Fixture mode is the default, so the explorer works without a key or network access.

## Use live WSDOT data

Request an access code from the [WSDOT Traveler Information API](https://wsdot.wa.gov/traffic/api/), create `.env.local` in the repository root, and set:

```dotenv
DATA_SOURCE=live
WSDOT_API_ACCESS_CODE=your-code
ENABLE_RAW_INSPECTOR=true
PORT=8787
```

The access code stays in the local Express server. Do not use a `VITE_` variable for it.

## Production-style local run

```powershell
npm run build
npm start
```

Open `http://127.0.0.1:8787`.

## Checks

```powershell
npm run lint
npm run typecheck
npm test
npm run build
npm run test:e2e
```