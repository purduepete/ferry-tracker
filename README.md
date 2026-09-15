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

### Past sailings

WSDOT drops a departure from the vehicle-space feed the moment it sails, so the two hours of past sailings the schedule shows would otherwise read `—`. When capture is enabled, `/api/schedule` fills those rows from the last reading taken before the boat left and marks them `spaceSource: "recorded"` with the capture time and how many seconds ahead of departure it landed. A short lead is close to what the boat actually left with; a long one means capture missed the final minutes. Live values always win, so an upcoming sailing is never overwritten. The UI mutes a recorded row and marks it with a history icon naming the capture time.

A multi-destination sailing is stored against its departing terminal because WSDOT puts the real destinations in `ArrivalTerminalIDs`, so that row stands in when no exact destination was recorded.

Each sailing also carries `actualDeparture` and `departureDelayMinutes` from `sailing_leg`, shown as a "Left 6 min late, 17:06" line and a **Left** column. A leg the rollup graded `low` or excluded never surfaces, since it would misreport lateness. Anything past 5 minutes is coloured as late.

### Browsing a past day

The **Day** picker lists up to 14 recorded service dates from `schedule_snapshot`, newest first. Picking one switches the schedule panel and the Sailings tab to two capture-only endpoints and stops calling WSDOT:

| Endpoint | Returns |
| --- | --- |
| `GET /api/history/dates?departingTerminalId=&arrivingTerminalId=` | The recorded service dates for that route |
| `GET /api/history/sailings?departingTerminalId=&arrivingTerminalId=&serviceDate=YYYY-MM-DD` | A full day of sailings, timetable plus recorded space and legs |

Both return 404 when capture is off. The day is read by its stored `service_date` and the space and leg window is derived from the first and last sailing plus 2 hours, which keeps the query off timezone math. A sailing capture never saw still appears from the timetable with an empty vehicle space, so a partial day reads as a partial day. Vessel positions have no history, so the panel dims and says so.

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

### Predicting an arrival

`GET /api/crossings` returns the median and tenth-percentile crossing time for every terminal pair, taken from the last 7 usable legs within a fortnight and cached for 2 minutes. A pair needs 3 legs to appear. A direction with none of its own borrows its reverse and is flagged `borrowed`, since a crossing runs close to the same length either way.

The Sailings, Disruption and Catch tabs all time an in-progress crossing from the observed departure plus the pair median, and fall back to the WSDOT vessel ETA when a pair has no measured history. Catch uses the tenth percentile instead of the median and refuses a borrowed or thin pair, because its projection only ever claims a boat cannot sail before it has arrived, so it has to stay a lower bound.

A boat that overruns its median has outrun what the median can say about it, so the arrival columns hand back to the WSDOT vessel ETA, which is still tracking the vessel's position. The handover takes the raw feed value rather than the delay-adjusted one used minutes after departure: an hour into a half-hour crossing, every ETA WSDOT has published since already prices that delay in, and adding it again costs the 6.91 min scored below. With both spent the estimate clamps to the current time and walks forward until the leg closes, rather than showing an arrival that has been and gone. Catch skips the handover and keeps the clamp, since the current time is the conservative floor there.

Backtested over 30 days and 2833 departures from a production snapshot:

| Estimator | Mean error | p90 |
| --- | --- | --- |
| Pair median | 2.10 min | 3.80 min |
| WSDOT ETA | 2.70 min | 4.37 min |
| WSDOT ETA plus departure delay | 6.91 min | 15.40 min |

Partitioning by vessel as well as pair moved the mean error by 0.01 min, and no major pair spread more than 4.5 min between its median and p90, so there is no vessel, hour or weekday bucketing. Re-run the comparison against a snapshot with:

```powershell
node deploy/backtest-crossings.mjs C:\ProgramData\ferry-tracker\ferry-capture.db
```

## Watch endpoint

`GET /api/catch` returns the Catch tab's answer as one line of text, so an Apple Shortcut can put it on a watch face:

```json
{ "data": { "summary": "Leave by 09:30 for the 10:00 Tacoma, 30 min", "windows": [ ... ] }, "raw": null }
```

Query parameters are `departingTerminalId`, `arrivingTerminalId`, and optional `traffic`, `queue` and `pad` minutes (0 to 180). The summary is built from `shared/src/catch.ts`, the same module the browser renders from, so the two cannot drift.

The route only exists when `CATCH_TOKEN` is set, and every request must carry that value in an `X-Ferry-Token` header. Without the header it returns a bare 401. Put the token in a header rather than the query string so it stays out of logs and referrers.

```dotenv
CATCH_TOKEN=<32 random bytes, hex>
```

Behind Cloudflare, this path carries an Access bypass so the watch can reach it without an email login, which leaves the token as the only gate on it. Deploy the token-enforcing server before creating that bypass. `deploy/Setup-Cloudflare.ps1` creates the bypass and caps the path at 10 requests a minute.

Setting or rotating the token means writing `.env.local`, restarting the scheduled task, and editing the Shortcut. Write the line with `WriteAllLines` rather than `Add-Content`: a `.env.local` with no trailing newline swallows an appended line onto the end of the previous one, and the installer then reports no token found.

```powershell
$t = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
$p = 'C:\Files\Dev\main\ferry_tracker\.env.local'
$lines = @([IO.File]::ReadAllLines($p) | Where-Object { $_ -notmatch '^\s*CATCH_TOKEN\s*=' }) + @('', "CATCH_TOKEN=$t")
[IO.File]::WriteAllLines($p, [string[]]$lines, (New-Object Text.UTF8Encoding($false)))
Stop-ScheduledTask -TaskName 'FerryTracker'; Start-ScheduledTask -TaskName 'FerryTracker'
$t
```

## Checks

```powershell
npm run lint
npm run typecheck
npm test
npm run build
npm run test:e2e
```