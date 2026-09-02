import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getConfig } from '../config.js';
import { openDatabase } from '../db/database.js';
import { renderReport } from './html.js';
import { collectReport } from './metrics.js';

const config = getConfig();
const dbPath = process.argv[2] ?? config.capture.dbPath;

if (!existsSync(dbPath)) {
  console.error(`No capture database at ${dbPath}. Run the server with CAPTURE_ENABLED=true first.`);
  process.exit(1);
}

const outputPath = path.join(path.dirname(path.resolve(dbPath)), 'capture-report.html');
const db = openDatabase(dbPath);

try {
  const data = collectReport(db, dbPath, {
    vessel_locations: config.capture.vesselIntervalMs,
    terminal_sailing_space: config.capture.spaceIntervalMs,
    reference: config.capture.referenceIntervalMs,
    schedule: config.capture.scheduleIntervalMs,
    rollup: config.capture.rollupIntervalMs,
  });
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, renderReport(data), 'utf8');
} finally {
  db.close();
}

console.log(outputPath);
open(outputPath);

function open(target: string): void {
  const command = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', target]] : ['open', [target]];
  spawn(command[0] as string, command[1] as string[], { detached: true, stdio: 'ignore' }).unref();
}
