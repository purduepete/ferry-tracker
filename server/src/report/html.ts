import type { DelayRow, DurationRow, FillCell, QualityRow, ReportData } from './metrics.js';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const ICONS: Record<string, string> = {
    database:
        '<path d="M3 5c0-1.1 4-2 9-2s9 .9 9 2-4 2-9 2-9-.9-9-2Z"/><path d="M3 5v14c0 1.1 4 2 9 2s9-.9 9-2V5"/><path d="M3 12c0 1.1 4 2 9 2s9-.9 9-2"/>',
    activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    ship: '<path d="M2 20a3 3 0 0 0 3-1 3 3 0 0 1 5 0 3 3 0 0 0 5 0 3 3 0 0 1 5 0 3 3 0 0 0 2 1"/><path d="M4 18 2 11h20l-2 7"/><path d="M12 3v8"/><path d="M7 11V7h10v4"/>',
    gauge: '<path d="M12 14 16 9"/><circle cx="12" cy="14" r="8"/><path d="M12 6V3"/>',
    shield: '<path d="M12 3 4 6v6c0 5 3.4 8.4 8 9 4.6-.6 8-4 8-9V6Z"/><path d="m9 12 2 2 4-4"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/>',
};

const icon = (name: string, size = 16): string =>
    `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;

const escape = (value: unknown): string => String(value).replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

const num = (value: number | null, suffix = ''): string =>
    value === null ? '<span class="muted">n/a</span>' : `${value}${suffix}`;

const localTime = (iso: string | null): string =>
    iso === null ? 'n/a' : new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export function renderReport(data: ReportData): string {
    const legs = data.counts.find((row) => row.table === 'sailing_leg')?.rows ?? 0;

    return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ferry capture report</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>${styles()}</style>
</head>
<body>
<header>
  <div class="head-row">
    <div>
      <h1>Ferry capture report</h1>
      <p class="sub">${escape(data.dbPath)}</p>
    </div>
    <button id="theme" type="button" aria-label="Toggle theme">${icon('sun')}${icon('moon')}<span id="theme-label">Dark</span></button>
  </div>
  <div class="meta">
    <span>Generated ${escape(data.generatedAt.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }))} local</span>
    <span>Capture window ${escape(localTime(data.window.first))} to ${escape(localTime(data.window.last))}</span>
    <span>${legs} sailing legs</span>
  </div>
</header>
<main>
  ${countsSection(data)}
  ${cadenceSection(data)}
  ${fillSection(data)}
  ${delaySection(data)}
  ${durationSection('crossing', 'How long does a crossing take', data.crossings)}
  ${durationSection('load', 'How long does loading take', data.loads)}
  ${qualitySection(data)}
</main>
<script>${script()}</script>
</body>
</html>`;
}

function section(id: string, iconName: string, title: string, note: string, body: string): string {
    return `<section id="${id}">
  <h2>${icon(iconName, 18)}${escape(title)}</h2>
  <p class="note">${note}</p>
  ${body}
</section>`;
}

function empty(message: string): string {
    return `<p class="empty">${escape(message)}</p>`;
}

function table(headers: string[], rows: string[][]): string {
    if (rows.length === 0) return empty('No rows yet.');
    return `<table>
  <thead><tr>${headers.map((head) => `<th>${escape(head)}</th>`).join('')}</tr></thead>
  <tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join('')}</tr>`).join('')}</tbody>
</table>`;
}

function countsSection(data: ReportData): string {
    const cards = data.counts
        .map(
            (row) =>
                `<div class="card"><span class="value">${row.rows.toLocaleString()}</span><span class="label">${escape(row.table)}</span></div>`
        )
        .join('');
    return section(
        'counts',
        'database',
        'What has been captured',
        'Row counts across every capture table.',
        `<div class="cards">${cards}</div>`
    );
}

function cadenceSection(data: ReportData): string {
    const rows = data.cadence.map((row) => [
        escape(row.task),
        row.intervalSeconds === null ? '<span class="muted">n/a</span>' : `${row.intervalSeconds}s`,
        String(row.changed),
        String(row.unchanged),
        row.skipRatio === null ? '<span class="muted">n/a</span>' : bar(row.skipRatio * 100),
        num(row.medianChangeGapSeconds, 's'),
        row.errors > 0 ? `<span class="bad">${row.errors}</span>` : '0',
    ]);

    const vessel = data.cadence.find((row) => row.task === 'vessel_locations');
    const gapClause =
        vessel?.medianChangeGapSeconds == null
            ? ''
            : ` The payload changed about every ${vessel.medianChangeGapSeconds} seconds.`;
    const verdict =
        vessel === undefined || vessel.skipRatio === null
            ? 'Not enough polls yet to judge the interval.'
            : vessel.skipRatio > 0.5
              ? `Vessel polling is too frequent. ${Math.round(vessel.skipRatio * 100)}% of polls returned data that had not changed.${gapClause}`
              : `Vessel polling is about right. Only ${Math.round(vessel.skipRatio * 100)}% of polls were unchanged.${gapClause}`;

    return section(
        'cadence',
        'activity',
        'Is polling every minute too frequent',
        escape(verdict),
        table(['Task', 'Interval', 'Changed', 'Unchanged', 'Skip rate', 'Median gap between changes', 'Errors'], rows) +
            table(
                ['Vessel', 'Observations', 'Distinct timestamps', 'Repeated timestamp rate'],
                data.vesselRatio.map((row) => [
                    escape(row.vesselName),
                    String(row.observations),
                    String(row.distinctTimestamps),
                    row.staleRatio === null ? '<span class="muted">n/a</span>' : bar(row.staleRatio * 100),
                ])
            )
    );
}

function fillSection(data: ReportData): string {
    const routes = table(
        ['Route', 'Sailings observed', 'Average full', 'Busiest hour'],
        data.fillByRoute.map((row) => [
            escape(row.route),
            String(row.sailings),
            row.avgPctFull === null ? '<span class="muted">n/a</span>' : bar(row.avgPctFull),
            row.busiestHour === null ? '<span class="muted">n/a</span>' : `${row.busiestHour}:00`,
        ])
    );
    return section(
        'fill',
        'gauge',
        'When are the busiest times',
        'Vehicle space consumed before departure, bucketed by Pacific weekday and hour.',
        heatmap(data.fillGrid) + routes
    );
}

function heatmap(cells: FillCell[]): string {
    if (cells.length === 0) return empty('No sailing space observations yet.');

    const hours = [...new Set(cells.map((cell) => cell.hour))].sort((a, b) => a - b);
    const days = [...new Set(cells.map((cell) => cell.weekday))].sort((a, b) => a - b);
    const lookup = new Map(cells.map((cell) => [`${cell.weekday}|${cell.hour}`, cell]));

    const header = `<tr><th></th>${hours.map((hour) => `<th class="hour">${hour}</th>`).join('')}</tr>`;
    const body = days
        .map((day) => {
            const row = hours
                .map((hour) => {
                    const cell = lookup.get(`${day}|${hour}`);
                    if (!cell || cell.avgPctFull === null) return '<td class="cell blank"></td>';
                    const alpha = Math.max(0.08, Math.min(1, cell.avgPctFull / 100));
                    return `<td class="cell" style="--fill:${alpha.toFixed(2)}" title="${WEEKDAYS[day]} ${hour}:00 — ${cell.avgPctFull}% full across ${cell.sailings} sailings">${Math.round(cell.avgPctFull)}</td>`;
                })
                .join('');
            return `<tr><th class="day">${WEEKDAYS[day]}</th>${row}</tr>`;
        })
        .join('');

    return `<table class="heat"><thead>${header}</thead><tbody>${body}</tbody></table>`;
}

function delaySection(data: ReportData): string {
    const rows = data.delays.map((row: DelayRow) => [
        `${row.hour}:00`,
        String(row.legs),
        num(row.medianMinutes, ' min'),
        num(row.p90Minutes, ' min'),
        row.onTimePct === null ? '<span class="muted">n/a</span>' : bar(row.onTimePct),
    ]);
    const note = `Departures with high or medium confidence only. ${data.delayExcluded} low confidence legs were left out. On time means within 5 minutes.`;
    return section(
        'delay',
        'clock',
        'When do ferries run late',
        escape(note),
        table(['Hour', 'Legs', 'Median delay', '90th percentile', 'On time'], rows)
    );
}

function durationSection(id: string, title: string, rows: DurationRow[]): string {
    return section(
        id,
        'ship',
        title,
        'High and medium confidence legs only.',
        table(
            ['Route', 'Legs', 'Median', '90th percentile', 'Fastest', 'Slowest'],
            rows.map((row) => [
                escape(row.route),
                String(row.legs),
                num(row.medianMinutes, ' min'),
                num(row.p90Minutes, ' min'),
                num(row.minMinutes, ' min'),
                num(row.maxMinutes, ' min'),
            ])
        )
    );
}

function qualitySection(data: ReportData): string {
    const list = (title: string, rows: QualityRow[]): string =>
        `<div class="quality"><h3>${escape(title)}</h3>${table(
            ['Value', 'Legs'],
            rows.map((row) => [escape(row.label), String(row.legs)])
        )}</div>`;

    return section(
        'quality',
        'shield',
        'Can these numbers be trusted',
        'Every leg carries a confidence and, when something is off, a reason. Filter on these before averaging anything.',
        `<div class="quality-grid">${list('Confidence', data.confidence)}${list('Departure exclusions', data.exclusions)}${list('Load time exclusions', data.loadExclusions)}</div>`
    );
}

function bar(percent: number): string {
    const clamped = Math.max(0, Math.min(100, percent));
    return `<span class="bar"><span class="bar-fill" style="width:${clamped.toFixed(0)}%"></span></span><span class="bar-text">${Math.round(percent)}%</span>`;
}

function styles(): string {
    return `
:root{color-scheme:dark}
html[data-theme=dark]{--bg:#0b0d12;--panel:#12151d;--panel-2:#171b25;--line:#242a38;--text:#e7eaf3;--muted:#8b93a7;--accent:#818cf8;--accent-2:#a78bfa;--bad:#f87171}
html[data-theme=light]{color-scheme:light;--bg:#f4f5f9;--panel:#ffffff;--panel-2:#f0f1f7;--line:#dfe2ec;--text:#151823;--muted:#666e85;--accent:#4f46e5;--accent-2:#7c3aed;--bad:#dc2626}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font-family:Inter,system-ui,sans-serif;font-size:14px;line-height:1.55}
header{border-bottom:1px solid var(--line);background:var(--panel);padding:24px 32px}
.head-row{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}
h1{margin:0;font-size:20px;font-weight:700;letter-spacing:-.01em}
.sub{margin:4px 0 0;color:var(--muted);font-size:12px;font-family:ui-monospace,Consolas,monospace;word-break:break-all}
.meta{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px}
.meta span{border:1px solid var(--line);background:var(--panel-2);padding:4px 10px;font-size:12px;color:var(--muted)}
button{display:inline-flex;align-items:center;gap:8px;border:1px solid var(--line);background:var(--panel-2);color:var(--text);font:inherit;font-size:12px;font-weight:500;padding:7px 12px;cursor:pointer}
button:hover{border-color:var(--accent)}
html[data-theme=dark] .icon-sun,html[data-theme=light] .icon-moon{display:none}
main{padding:24px 32px 64px;display:flex;flex-direction:column;gap:20px;max-width:1200px;margin:0 auto}
section{border:1px solid var(--line);background:var(--panel);padding:20px 22px}
h2{display:flex;align-items:center;gap:9px;margin:0;font-size:15px;font-weight:600}
h2 .icon{color:var(--accent)}
h3{margin:0 0 8px;font-size:12px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.05em}
.note{margin:6px 0 16px;color:var(--muted);font-size:13px;max-width:78ch}
.empty{margin:0;color:var(--muted);font-size:13px;font-style:italic}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px}
.card{border:1px solid var(--line);background:var(--panel-2);padding:12px 14px;display:flex;flex-direction:column;gap:2px}
.card .value{font-size:20px;font-weight:700;font-variant-numeric:tabular-nums}
.card .label{font-size:11px;color:var(--muted);font-family:ui-monospace,Consolas,monospace}
table{width:100%;border-collapse:collapse;margin-bottom:14px;font-variant-numeric:tabular-nums}
table:last-child{margin-bottom:0}
th,td{text-align:left;padding:7px 10px;border-bottom:1px solid var(--line)}
th{font-size:11px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
tbody tr:last-child td{border-bottom:none}
tbody tr:hover{background:var(--panel-2)}
.muted{color:var(--muted)}
.bad{color:var(--bad);font-weight:600}
.bar{display:inline-block;vertical-align:middle;width:90px;height:7px;background:var(--panel-2);border:1px solid var(--line);margin-right:8px}
.bar-fill{display:block;height:100%;background:linear-gradient(90deg,var(--accent),var(--accent-2))}
.bar-text{font-size:12px}
.heat{width:auto;margin-bottom:18px}
.heat th.hour{padding:4px 0;text-align:center;font-size:10px}
.heat th.day{padding-right:10px;font-size:11px}
.heat td.cell{width:30px;height:26px;padding:0;text-align:center;font-size:11px;border:1px solid var(--bg);background:color-mix(in srgb,var(--accent) calc(var(--fill)*100%),transparent)}
.heat td.blank{background:var(--panel-2)}
.quality-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:18px}
@media(max-width:760px){header,main{padding-left:16px;padding-right:16px}.head-row{flex-direction:column}}
`;
}

function script(): string {
    return `
const root=document.documentElement,btn=document.getElementById('theme'),label=document.getElementById('theme-label');
const svgs=btn.querySelectorAll('svg');svgs[0].classList.add('icon-sun');svgs[1].classList.add('icon-moon');
const stored=localStorage.getItem('ferry-report-theme');
const system=window.matchMedia('(prefers-color-scheme: light)').matches?'light':'dark';
const apply=t=>{root.dataset.theme=t;label.textContent=t==='dark'?'Dark':'Light'};
apply(stored||system);
btn.addEventListener('click',()=>{const next=root.dataset.theme==='dark'?'light':'dark';localStorage.setItem('ferry-report-theme',next);apply(next)});
`;
}
