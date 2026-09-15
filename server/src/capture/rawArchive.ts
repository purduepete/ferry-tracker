import { appendFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { pacificParts, redactSecrets } from '@ferry-tracker/shared';
import type { Db } from '../db/database.js';
import { checkFreeSpace } from './diskSpace.js';
import type { EndpointId } from './endpoints.js';
import { canonical, sha256 } from './hash.js';

export interface ArchiveResult {
  hash: string;
  written: boolean;
  reason?: 'unchanged' | 'disk_space' | 'disabled';
}

export class RawArchive {
  private readonly lastHash = new Map<string, string>();

  constructor(
    private readonly db: Db,
    private readonly directory: string,
    private readonly minFreeDiskMb: number,
    private readonly secrets?: readonly string[],
  ) {}

  /** `context` separates a fan-out endpoint's variants, such as one schedule per terminal pair. */
  async append(endpointId: EndpointId, capturedAt: string, body: unknown, context?: string): Promise<ArchiveResult> {
    const payload = redactSecrets(canonical(body), this.secrets);
    const hash = sha256(payload);
    const dedupeKey = context ? `${endpointId}|${context}` : endpointId;
    if (this.lastHash.get(dedupeKey) === hash) return { hash, written: false, reason: 'unchanged' };

    await mkdir(this.directory, { recursive: true });
    const space = await checkFreeSpace(this.directory, this.minFreeDiskMb);
    if (!space.ok) return { hash, written: false, reason: 'disk_space' };

    const serviceDate = pacificParts(capturedAt)?.serviceDate ?? capturedAt.slice(0, 10);
    const filePath = path.join(this.directory, `${endpointId}-${serviceDate}.ndjson.gz`);
    const line = `${JSON.stringify({ capturedAt, endpointId, context: context ?? null, hash, body: JSON.parse(payload) as unknown })}\n`;

    // One gzip member per line. Concatenated members decompress as a single stream.
    await appendFile(filePath, gzipSync(Buffer.from(line, 'utf8')));
    this.lastHash.set(dedupeKey, hash);
    await this.record(endpointId, serviceDate, filePath, capturedAt);
    return { hash, written: true };
  }

  private async record(endpointId: EndpointId, serviceDate: string, filePath: string, capturedAt: string): Promise<void> {
    const byteSize = await stat(filePath).then((info) => info.size, () => 0);
    const existing = this.db
      .prepare('SELECT id, member_count FROM archive_file WHERE endpoint_id = ? AND service_date = ?')
      .get(endpointId, serviceDate) as { id: number; member_count: number } | undefined;

    if (existing) {
      this.db
        .prepare('UPDATE archive_file SET member_count = ?, byte_size = ?, updated_at = ? WHERE id = ?')
        .run(existing.member_count + 1, byteSize, capturedAt, existing.id);
      return;
    }
    this.db
      .prepare(`INSERT INTO archive_file (endpoint_id, service_date, path, member_count, byte_size, created_at, updated_at)
        VALUES (?, ?, ?, 1, ?, ?, ?)`)
      .run(endpointId, serviceDate, filePath, byteSize, capturedAt, capturedAt);
  }
}
