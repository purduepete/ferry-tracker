// Phase 0 gate for the crossing-median predictor. Scores four ways of guessing when an
// underway boat docks, against what the rollup actually recorded, so the change ships on
// measured error rather than on the argument that it ought to be better.
//
// Read-only, and pointed at a snapshot copy. Never run this against the live capture
// database: `node deploy/backtest-crossings.mjs <path-to-snapshot.db>`.
import process from 'node:process';
import Database from 'better-sqlite3';

const DEFAULT_SNAPSHOT = `${process.env.TEMP}\\ferry-prod\\ferry-capture.db`;
if (process.env.STORAGE_BACKEND === 'postgresql')
    throw new Error(
        'SQLite backtesting is disabled for PostgreSQL runtime. Use an explicitly reviewed source snapshot environment.'
    );
const dbPath = process.argv[2] ?? DEFAULT_SNAPSHOT;

const WINDOW = Number(process.env.BACKTEST_WINDOW ?? 7);
const DAYS = Number(process.env.BACKTEST_DAYS ?? 30);
const MIN_SAMPLES = 3;
// A boat publishes its ETA once it is clear of the slip, so allow a few polls after pushback.
const ETA_LOOKAHEAD_MS = 10 * 60 * 1000;

const db = new Database(dbPath, { readonly: true, fileMustExist: true });

// Nearest rank, matching server/src/report/metrics.ts so the backtest scores the statistic
// that would actually ship.
function percentile(values, fraction) {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
    return sorted[index];
}

const since = new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000).toISOString();

const legs = db
    .prepare(
        `
  SELECT vessel_id, vessel_name, departing_terminal_id, arriving_terminal_id,
         departed_at, dock_arrival_at, crossing_minutes, departure_delay_minutes, hour_local
  FROM sailing_leg
  WHERE complete = 1
    AND crossing_minutes IS NOT NULL
    AND crossing_minutes > 0
    AND confidence <> 'low'
    AND exclusion_reason IS NULL
    AND departing_terminal_id IS NOT NULL
    AND arriving_terminal_id IS NOT NULL
    AND departed_at >= ?
  ORDER BY departed_at
`
    )
    .all(since);

const terminalName = new Map(
    db
        .prepare('SELECT terminal_id, terminal_name FROM terminal_reference')
        .all()
        .map((row) => [row.terminal_id, row.terminal_name])
);

const etaStatement = db.prepare(`
  SELECT eta FROM vessel_observation
  WHERE vessel_id = ? AND eta IS NOT NULL
    AND captured_at >= ? AND captured_at <= ?
  ORDER BY captured_at
  LIMIT 1
`);

const pairKey = (leg) => `${leg.departing_terminal_id}-${leg.arriving_terminal_id}`;
const vesselKey = (leg) => `${pairKey(leg)}-${leg.vessel_id}`;
const label = (key) => {
    const [dep, arr] = key.split('-');
    return `${terminalName.get(Number(dep)) ?? dep} -> ${terminalName.get(Number(arr)) ?? arr}`;
};

// --- Phase 0a: how much does a crossing actually vary? -----------------------

const byPair = new Map();
for (const leg of legs) {
    const key = pairKey(leg);
    if (!byPair.has(key)) byPair.set(key, []);
    byPair.get(key).push(leg.crossing_minutes);
}

console.log(`snapshot: ${dbPath}`);
console.log(`legs: ${legs.length} complete, last ${DAYS} days, window N=${WINDOW}\n`);
console.log('crossing spread by pair');
console.log('  legs   min    p50    p90    max   p90-p50  route');
for (const [key, values] of [...byPair.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const p50 = percentile(values, 0.5);
    const p90 = percentile(values, 0.9);
    if (values.length < 10) continue;
    console.log(
        `  ${String(values.length).padStart(4)}  ${percentile(values, 0).toFixed(1).padStart(5)}` +
            `  ${p50.toFixed(1).padStart(5)}  ${p90.toFixed(1).padStart(5)}` +
            `  ${percentile(values, 1).toFixed(1).padStart(5)}  ${(p90 - p50).toFixed(1).padStart(7)}  ${label(key)}`
    );
}

// --- Phase 0b: replay each departure with only what was known at the time ----

const pairHistory = new Map();
const vesselHistory = new Map();
const lastVesselOnPair = new Map();

const arms = {
    'pair median': [],
    'vessel median': [],
    'wsdot eta': [],
    'wsdot eta + delay': [],
};
const swapArms = { 'pair median': [], 'vessel median': [] };
const catchArm = { 'pair p10': [], 'wsdot eta + delay': [] };

let scored = 0;
let missingEta = 0;

for (const leg of legs) {
    const pk = pairKey(leg);
    const vk = vesselKey(leg);
    const departedAt = Date.parse(leg.departed_at);
    const truth = Date.parse(leg.dock_arrival_at);

    const pairSamples = pairHistory.get(pk) ?? [];
    const vesselSamples = vesselHistory.get(vk) ?? [];
    const isSwap = lastVesselOnPair.has(pk) && lastVesselOnPair.get(pk) !== leg.vessel_id;

    const record = (bucket, name, predicted) => {
        if (predicted === null) return;
        bucket[name].push(Math.abs(predicted - truth) / 60000);
    };

    if (pairSamples.length >= MIN_SAMPLES) {
        const median = percentile(pairSamples, 0.5);
        const fast = percentile(pairSamples, 0.1);
        const pairPredicted = departedAt + median * 60000;

        // Arm 2 only earns its extra complexity when its own sample is deep enough.
        const vesselPredicted =
            vesselSamples.length >= MIN_SAMPLES ? departedAt + percentile(vesselSamples, 0.5) * 60000 : pairPredicted;

        const row = etaStatement.get(
            leg.vessel_id,
            leg.departed_at,
            new Date(departedAt + ETA_LOOKAHEAD_MS).toISOString()
        );
        const rawEta = row ? Date.parse(row.eta) : null;
        const delayMs = (leg.departure_delay_minutes ?? 0) * 60000;
        // What production renders today: the raw ETA with the departure delay added back on.
        const adjustedEta = rawEta !== null && leg.departure_delay_minutes >= 2 ? rawEta + delayMs : rawEta;

        if (rawEta === null) missingEta++;

        record(arms, 'pair median', pairPredicted);
        record(arms, 'vessel median', vesselPredicted);
        record(arms, 'wsdot eta', rawEta);
        record(arms, 'wsdot eta + delay', adjustedEta);
        record(catchArm, 'pair p10', departedAt + fast * 60000);
        record(catchArm, 'wsdot eta + delay', adjustedEta);

        if (isSwap) {
            record(swapArms, 'pair median', pairPredicted);
            record(swapArms, 'vessel median', vesselPredicted);
        }
        scored++;
    }

    pairSamples.push(leg.crossing_minutes);
    if (pairSamples.length > WINDOW) pairSamples.shift();
    pairHistory.set(pk, pairSamples);

    vesselSamples.push(leg.crossing_minutes);
    if (vesselSamples.length > WINDOW) vesselSamples.shift();
    vesselHistory.set(vk, vesselSamples);

    lastVesselOnPair.set(pk, leg.vessel_id);
}

function report(title, bucket) {
    console.log(`\n${title}`);
    console.log('     n    MAE    p90    max  arm');
    for (const [name, errors] of Object.entries(bucket)) {
        if (errors.length === 0) {
            console.log(`     0      -      -      -  ${name}`);
            continue;
        }
        const mae = errors.reduce((sum, value) => sum + value, 0) / errors.length;
        console.log(
            `  ${String(errors.length).padStart(4)}  ${mae.toFixed(2).padStart(5)}` +
                `  ${percentile(errors, 0.9).toFixed(2).padStart(5)}  ${percentile(errors, 1).toFixed(2).padStart(5)}  ${name}`
        );
    }
}

console.log(`\nscored ${scored} departures (${missingEta} had no WSDOT ETA within 10 min of pushback)`);
report('absolute arrival error, minutes', arms);
report('boat-swap legs only', swapArms);
report('Catch lower bound (lower is later, so also check the bias below)', catchArm);

// Catch needs the projection to be EARLY, so signed bias matters more than magnitude there.
const signed = [];
const pairHistory2 = new Map();
for (const leg of legs) {
    const pk = pairKey(leg);
    const samples = pairHistory2.get(pk) ?? [];
    if (samples.length >= MIN_SAMPLES) {
        const fast = percentile(samples, 0.1);
        signed.push((Date.parse(leg.departed_at) + fast * 60000 - Date.parse(leg.dock_arrival_at)) / 60000);
    }
    samples.push(leg.crossing_minutes);
    if (samples.length > WINDOW) samples.shift();
    pairHistory2.set(pk, samples);
}
const late = signed.filter((value) => value > 0);
console.log(
    `\np10 projection was LATE on ${late.length}/${signed.length} legs ` +
        `(${((late.length / signed.length) * 100).toFixed(1)}%), worst ${Math.max(0, ...late).toFixed(1)} min late`
);

db.close();
