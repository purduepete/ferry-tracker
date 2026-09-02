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

## Data capture

Capture is off unless `CAPTURE_ENABLED=true`. It writes to a SQLite file plus a gzipped NDJSON archive of every raw WSDOT response, both under `CAPTURE_DATA_DIR` (default `./data`, git-ignored). Leave it off on a development laptop and turn it on only where the server runs continuously.

```powershell
$env:CAPTURE_ENABLED = 'true'
npm start
Invoke-RestMethod http://127.0.0.1:8787/api/capture/status
```

Five loops run on independent timers, and a run that is still in flight is skipped rather than queued.

| Task | Variable | Default |
| --- | --- | --- |
| `vessel_locations` | `CAPTURE_VESSEL_INTERVAL_MS` | 30000 |
| `terminal_sailing_space` | `CAPTURE_SPACE_INTERVAL_MS` | 60000 |
| `reference` | `CAPTURE_REFERENCE_INTERVAL_MS` | 21600000 |
| `schedule` | `CAPTURE_SCHEDULE_INTERVAL_MS` | 21600000 |
| `rollup` | `CAPTURE_ROLLUP_INTERVAL_MS` | 900000 |

A poll whose payload hash matches the previous one is recorded as `skipped_unchanged` and nothing is stored, so a high poll rate costs little. `CAPTURE_MIN_FREE_DISK_MB` (default 512) halts archiving before the disk fills. `CAPTURE_RETENTION_DAYS` is unset by default, which keeps everything; when it is set, the prune still refuses to delete anything the rollup has not yet processed. `CAPTURE_ALLOW_FIXTURE=true` lets capture run against fixtures for a smoke test.

### Analysis

The `rollup` task rebuilds `sailing_leg` from the raw vessel observations. Each leg pairs a departure with the following dock arrival and carries a `confidence` of `high`, `medium` or `low`, plus an `exclusion_reason` when the departure itself is untrustworthy and a separate `load_exclusion_reason` when only the dwell is. Filter on those before averaging anything. Legs are derived, so dropping the table and rerunning the rollup reproduces it exactly.

Six views answer the original questions:

| View | Question |
| --- | --- |
| `v_sailing_fill` | When are the busiest times, by vehicle space |
| `v_departure_delay` | When do ferries run late |
| `v_crossing_duration` | How long does a crossing take |
| `v_load_duration` | How long does loading take |
| `v_update_cadence` | Is a poll every minute too frequent |
| `v_vessel_update_ratio` | How often does a vessel's own timestamp actually move |

Every view buckets by `service_date`, `weekday` and `hour_local` in Pacific time, computed in TypeScript rather than SQL, so the schema ports to Azure SQL without rewriting date logic.

To read the results, generate an HTML report next to the database and open it:

```powershell
npm run capture:report
npm run capture:report -- C:\ProgramData\ferry-tracker\ferry-capture.db
```

It works against a live database, so you can run it while the server is still capturing.

## Checks

```powershell
npm run lint
npm run typecheck
npm test
npm run build
npm run test:e2e
```