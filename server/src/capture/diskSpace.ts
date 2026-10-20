import { statfs } from 'node:fs/promises';

export interface DiskSpace {
    freeMb: number;
    ok: boolean;
}

/**
 * Returns ok = true when the check itself fails, so a platform that cannot report
 * free space never silently halts capture.
 */
export async function checkFreeSpace(targetPath: string, minFreeMb: number): Promise<DiskSpace> {
    try {
        const stats = await statfs(targetPath);
        const freeMb = (Number(stats.bavail) * Number(stats.bsize)) / (1024 * 1024);
        return { freeMb, ok: freeMb >= minFreeMb };
    } catch {
        return { freeMb: Number.POSITIVE_INFINITY, ok: true };
    }
}
