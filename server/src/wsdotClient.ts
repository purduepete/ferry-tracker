import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppConfig } from './config.js';

type Service = 'Terminals' | 'Vessels' | 'Schedule';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cache = new Map<string, { expiresAt: number; value: unknown }>();

const fixtureNames: Record<string, string> = {
  'Terminals/terminalbasics': 'terminalbasics.json',
  'Terminals/terminallocations': 'terminallocations.json',
  'Vessels/vesselbasics': 'vesselbasics.json',
  'Vessels/vessellocations': 'vessellocations.json',
};

export class WsdotClient {
  constructor(private readonly config: AppConfig) {}

  getTerminalBasics(): Promise<unknown> {
    return this.get('Terminals', 'terminalbasics');
  }

  getTerminalLocations(): Promise<unknown> {
    return this.get('Terminals', 'terminallocations');
  }

  getVesselBasics(): Promise<unknown> {
    return this.get('Vessels', 'vesselbasics');
  }

  getVesselLocations(bypassCache = false): Promise<unknown> {
    return this.get('Vessels', 'vessellocations', undefined, bypassCache);
  }

  getTerminalMates(): Promise<unknown> {
    return this.config.dataSource === 'fixture'
      ? this.readFixture('terminalmates.json')
      : this.get('Schedule', `terminalsandmates/${pacificDate()}`);
  }

  // Cameras live in the traveler information API, which has a different path and spells the key AccessCode.
  // Caching is left to the caller because the inventory changes on the order of months, not seconds.
  async getHighwayCameras(): Promise<unknown> {
    if (this.config.dataSource === 'fixture') return this.readFixture('highwaycameras.json');
    if (!this.config.apiAccessCode) throw new Error('WSDOT_API_ACCESS_CODE is required in live mode.');
    const url = new URL('https://www.wsdot.wa.gov/Traffic/api/HighwayCameras/HighwayCamerasREST.svc/GetCamerasAsJson');
    url.searchParams.set('AccessCode', this.config.apiAccessCode);
    return this.fetchJson(url);
  }

  getTerminalSailingSpaces(bypassCache = false): Promise<unknown> {
    return this.get('Terminals', 'terminalsailingspace', 'terminalsailingspace.json', bypassCache);
  }

  getSchedule(departingId: number, arrivingId: number, onlyRemaining: boolean): Promise<unknown> {
    return this.get('Schedule', `scheduletoday/${departingId}/${arrivingId}/${onlyRemaining}`, `schedule-${departingId}-${arrivingId}.json`);
  }

  async getScheduleRange(departingId: number, arrivingId: number, start: number, end: number): Promise<unknown> {
    if (this.config.dataSource === 'fixture') {
      return this.readFixture(`schedule-${departingId}-${arrivingId}.json`);
    }
    const dates = [...new Set([pacificDate(start), pacificDate(end)])];
    return Promise.all(dates.map((date) => this.get('Schedule', `schedule/${date}/${departingId}/${arrivingId}`)));
  }

  private async get(service: Service, operation: string, fixtureName?: string, bypassCache = false): Promise<unknown> {
    const key = `${service}/${operation}`;
    const cached = cache.get(key);
    if (!bypassCache && cached && cached.expiresAt > Date.now()) return cached.value;

    const value = this.config.dataSource === 'fixture'
      ? await this.readFixture(fixtureName ?? fixtureNames[key])
      : await this.fetchLive(service, operation);
    cache.set(key, { expiresAt: Date.now() + 30_000, value });
    return value;
  }

  private async readFixture(name?: string): Promise<unknown> {
    if (!name) return { TerminalCombos: [] };
    try {
      const contents = await readFile(path.join(serverRoot, 'fixtures', name), 'utf8');
      return JSON.parse(contents) as unknown;
    } catch (error) {
      if (name.startsWith('schedule-')) return { TerminalCombos: [] };
      throw error;
    }
  }

  private async fetchLive(service: Service, operation: string): Promise<unknown> {
    if (!this.config.apiAccessCode) throw new Error('WSDOT_API_ACCESS_CODE is required in live mode.');
    const url = new URL(`https://www.wsdot.wa.gov/Ferries/API/${service}/rest/${operation}`);
    url.searchParams.set('apiaccesscode', this.config.apiAccessCode);
    return this.fetchJson(url);
  }

  private async fetchJson(url: URL): Promise<unknown> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await fetch(url, {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) throw new Error(`WSDOT returned HTTP ${response.status}.`);
        return await response.json() as unknown;
      } catch (error) {
        lastError = error;
        if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    throw lastError;
  }
}

function pacificDate(timestamp: number = Date.now()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(timestamp));
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}