# Ferry Tracker

A local Phase 0 explorer for Washington State Ferries terminal, vessel, and schedule data.

## Run the POC

```powershell
npm install
npm run dev
```

Open `http://127.0.0.1:5173` on this computer, or `http://<this-computer-ip>:5173` on another device on the same LAN. Fixture mode is the default, so the explorer works without a key or internet access.

## Use live WSDOT data

Request an access code from the [WSDOT Traveler Information API](https://wsdot.wa.gov/traffic/api/), create `.env.local` in the repository root, and set:

```dotenv
DATA_SOURCE=live
WSDOT_API_ACCESS_CODE=your-code
ENABLE_RAW_INSPECTOR=true
HOST=0.0.0.0
PORT=8787
```

The access code stays in the local Express server. Do not use a `VITE_` variable for it.

## Production-style local run

```powershell
npm run build
npm start
```

Open `http://127.0.0.1:8787` on this computer, or `http://<this-computer-ip>:8787` on another device on the same LAN. To find this computer's IPv4 address, run `Get-NetIPAddress -AddressFamily IPv4` in PowerShell and use the address for the active network adapter.

Both run modes listen on all local interfaces by default. Set `HOST=127.0.0.1` to restrict the production server to this computer. If another device cannot connect, allow Node.js or the relevant TCP port through Windows Defender Firewall for private networks.

## Checks

```powershell
npm run lint
npm run typecheck
npm test
npm run build
npm run test:e2e
```