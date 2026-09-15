import { pacificParts, redactSecrets } from '@ferry-tracker/shared';
import type { AppConfig } from '../config.js';
import type { Db } from '../db/database.js';
import { runLegRollup } from '../rollup/legRollup.js';
import type { WsdotClient } from '../wsdotClient.js';
import type { EndpointId } from './endpoints.js';
import { RawArchive } from './rawArchive.js';
import { writeReferenceData, writeScheduleSnapshots } from './referenceWriters.js';
import { pruneOldData } from './retention.js';
import { writeSailingSpaceObservations, writeVesselObservations } from './writers.js';

export type RunOutcome = 'success' | 'skipped_overlap' | 'skipped_unchanged' | 'skipped_disk_space' | 'error';

export interface TaskOutcome {
  rowsWritten: number;
  rowsSkipped: number;
  responseHash?: string;
  changed?: boolean;
  outcome?: RunOutcome;
}

interface TaskDefinition {
  name: string;
  endpointId: EndpointId | null;
  intervalMs: number;
  run: (capturedAt: string) => Promise<TaskOutcome>;
}

interface TaskState {
  definition: TaskDefinition;
  running: boolean;
  timer: NodeJS.Timeout | null;
}

export class CaptureService {
  private readonly archive: RawArchive;
  private readonly tasks: TaskState[];
  private started = false;
  private stopping = false;

  constructor(
    private readonly db: Db,
    private readonly client: WsdotClient,
    private readonly config: AppConfig,
    private readonly now: () => number = Date.now,
  ) {
    const capture = config.capture;
    this.archive = new RawArchive(db, capture.rawArchiveDir, capture.minFreeDiskMb, config.secrets);
    const definitions: TaskDefinition[] = [
      {
        name: 'vessel_locations',
        endpointId: 'vessel_locations',
        intervalMs: capture.vesselIntervalMs,
        run: (capturedAt) => this.captureVessels(capturedAt),
      },
      {
        name: 'terminal_sailing_space',
        endpointId: 'terminal_sailing_space',
        intervalMs: capture.spaceIntervalMs,
        run: (capturedAt) => this.captureSpaces(capturedAt),
      },
      {
        name: 'reference',
        endpointId: null,
        intervalMs: capture.referenceIntervalMs,
        run: (capturedAt) => this.captureReference(capturedAt),
      },
      {
        name: 'schedule',
        endpointId: null,
        intervalMs: capture.scheduleIntervalMs,
        run: (capturedAt) => this.captureSchedule(capturedAt),
      },
      {
        name: 'rollup',
        endpointId: null,
        intervalMs: capture.rollupIntervalMs,
        run: () => this.rollup(),
      },
    ];
    this.tasks = definitions.map((definition) => ({ definition, running: false, timer: null }));
  }

  start(): void {
    if (this.started) return;
    if (this.config.dataSource === 'fixture' && !this.config.capture.allowFixtureSource) {
      console.log('Capture is enabled but DATA_SOURCE is fixture. Set CAPTURE_ALLOW_FIXTURE=true to capture fixtures.');
      return;
    }
    this.started = true;
    this.stopping = false;
    for (const task of this.tasks) this.schedule(task, 0);
  }

  stop(): void {
    this.stopping = true;
    this.started = false;
    for (const task of this.tasks) {
      if (task.timer) clearTimeout(task.timer);
      task.timer = null;
    }
  }

  status(): unknown {
    const rows = this.db
      .prepare(`SELECT task, outcome, COUNT(*) AS runs, MAX(started_at) AS last_started_at
        FROM capture_run GROUP BY task, outcome`)
      .all() as Array<{ task: string; outcome: string; runs: number; last_started_at: string }>;
    const errors = this.db
      .prepare(`SELECT task, error_category, COUNT(*) AS runs, MAX(started_at) AS last_started_at
        FROM capture_run WHERE error_category IS NOT NULL GROUP BY task, error_category`)
      .all() as Array<{ task: string; error_category: string; runs: number; last_started_at: string }>;
    const counts = this.db
      .prepare(`SELECT 'vessel_observation' AS name, COUNT(*) AS rows FROM vessel_observation
        UNION ALL SELECT 'sailing_space_observation', COUNT(*) FROM sailing_space_observation
        UNION ALL SELECT 'schedule_snapshot', COUNT(*) FROM schedule_snapshot
        UNION ALL SELECT 'sailing_leg', COUNT(*) FROM sailing_leg`)
      .all() as Array<{ name: string; rows: number }>;

    return {
      running: this.started,
      tasks: this.tasks.map((task) => ({
        name: task.definition.name,
        intervalMs: task.definition.intervalMs,
        inFlight: task.running,
        outcomes: rows.filter((row) => row.task === task.definition.name),
      })),
      // Categories only. Error detail stays in the database so no secret can reach a caller.
      errorCategories: errors,
      tableCounts: counts,
    };
  }

  private schedule(task: TaskState, delayMs: number): void {
    if (this.stopping) return;
    task.timer = setTimeout(() => void this.execute(task), delayMs);
    task.timer.unref();
  }

  private async execute(task: TaskState): Promise<void> {
    const startedAt = new Date(this.now()).toISOString();
    const startedMs = this.now();

    if (task.running) {
      this.record(task, startedAt, startedMs, { rowsWritten: 0, rowsSkipped: 0, outcome: 'skipped_overlap' });
      this.schedule(task, task.definition.intervalMs);
      return;
    }

    task.running = true;
    try {
      const result = await task.definition.run(startedAt);
      this.record(task, startedAt, startedMs, result);
    } catch (error) {
      this.recordError(task, startedAt, startedMs, error);
    } finally {
      task.running = false;
      this.schedule(task, task.definition.intervalMs);
    }
  }

  private record(task: TaskState, startedAt: string, startedMs: number, result: TaskOutcome): void {
    if (this.stopping) return;
    this.db
      .prepare(`INSERT INTO capture_run (
        task, endpoint_id, started_at, finished_at, duration_ms, response_hash, changed,
        rows_written, rows_skipped, outcome, error_category, error_detail, service_date
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`)
      .run(
        task.definition.name,
        task.definition.endpointId,
        startedAt,
        new Date(this.now()).toISOString(),
        this.now() - startedMs,
        result.responseHash ?? null,
        result.changed === undefined ? null : result.changed ? 1 : 0,
        result.rowsWritten,
        result.rowsSkipped,
        result.outcome ?? 'success',
        pacificParts(startedAt)?.serviceDate ?? null,
      );
  }

  private recordError(task: TaskState, startedAt: string, startedMs: number, error: unknown): void {
    // stop() cannot cancel a request already in flight and the caller closes the database
    // straight after, so a late run row would throw on a closed connection.
    if (this.stopping) return;
    this.db
      .prepare(`INSERT INTO capture_run (
        task, endpoint_id, started_at, finished_at, duration_ms, response_hash, changed,
        rows_written, rows_skipped, outcome, error_category, error_detail, service_date
      ) VALUES (?, ?, ?, ?, ?, NULL, NULL, 0, 0, 'error', ?, ?, ?)`)
      .run(
        task.definition.name,
        task.definition.endpointId,
        startedAt,
        new Date(this.now()).toISOString(),
        this.now() - startedMs,
        categorize(error),
        redactSecrets(error, this.config.secrets).slice(0, 2000),
        pacificParts(startedAt)?.serviceDate ?? null,
      );
  }

  private async rollup(): Promise<TaskOutcome> {
    const legs = runLegRollup(this.db, {
      dwellCeilingMinutes: this.config.capture.dwellCeilingMinutes,
      dockDebounceSeconds: this.config.capture.dockDebounceSeconds,
      now: this.now(),
    });
    const pruned = await pruneOldData(this.db, { retentionDays: this.config.capture.retentionDays, now: this.now });
    const removed =
      pruned.vesselObservations + pruned.sailingSpaceObservations + pruned.sailingSpaceDepartures + pruned.captureRuns;
    return { rowsWritten: legs.legsWritten, rowsSkipped: removed };
  }

  private async captureVessels(capturedAt: string): Promise<TaskOutcome> {
    const payload = await this.client.getVesselLocations(true);
    const archived = await this.archive.append('vessel_locations', capturedAt, payload);
    if (archived.reason === 'disk_space') {
      return { rowsWritten: 0, rowsSkipped: 0, responseHash: archived.hash, changed: true, outcome: 'skipped_disk_space' };
    }
    if (!archived.written) {
      return { rowsWritten: 0, rowsSkipped: 0, responseHash: archived.hash, changed: false, outcome: 'skipped_unchanged' };
    }
    const result = writeVesselObservations(this.db, payload, capturedAt);
    return { rowsWritten: result.written, rowsSkipped: result.skipped, responseHash: archived.hash, changed: true };
  }

  private async captureSpaces(capturedAt: string): Promise<TaskOutcome> {
    const payload = await this.client.getTerminalSailingSpaces(true);
    const archived = await this.archive.append('terminal_sailing_space', capturedAt, payload);
    if (archived.reason === 'disk_space') {
      return { rowsWritten: 0, rowsSkipped: 0, responseHash: archived.hash, changed: true, outcome: 'skipped_disk_space' };
    }
    if (!archived.written) {
      return { rowsWritten: 0, rowsSkipped: 0, responseHash: archived.hash, changed: false, outcome: 'skipped_unchanged' };
    }
    const result = writeSailingSpaceObservations(this.db, payload, capturedAt);
    return { rowsWritten: result.written, rowsSkipped: result.skipped, responseHash: archived.hash, changed: true };
  }

  private async captureReference(capturedAt: string): Promise<TaskOutcome> {
    const [vessels, terminals] = await Promise.all([
      this.client.getVesselBasics(),
      this.client.getTerminalLocations(),
    ]);
    await this.archive.append('vessel_basics', capturedAt, vessels);
    await this.archive.append('terminal_locations', capturedAt, terminals);
    const result = writeReferenceData(this.db, vessels, terminals, capturedAt);
    return { rowsWritten: result.written, rowsSkipped: result.skipped };
  }

  private async captureSchedule(capturedAt: string): Promise<TaskOutcome> {
    const mates = await this.client.getTerminalMates();
    await this.archive.append('terminal_mates', capturedAt, mates);
    const result = await writeScheduleSnapshots(this.db, this.client, mates, capturedAt, (payload, pair) =>
      this.archive.append('schedule_today', capturedAt, payload, pair).then(() => undefined),
    );
    return { rowsWritten: result.written, rowsSkipped: result.skipped };
  }
}

function categorize(error: unknown): string {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  if (/TimeoutError|aborted|ETIMEDOUT/i.test(message)) return 'wsdot_timeout';
  if (/HTTP \d{3}/.test(message)) return 'wsdot_http';
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|fetch failed/i.test(message)) return 'wsdot_unreachable';
  if (/ENOSPC/i.test(message)) return 'disk_space';
  if (/SQLITE|constraint/i.test(message)) return 'persistence';
  if (/ZodError|invalid/i.test(message)) return 'validation';
  return 'unknown';
}
