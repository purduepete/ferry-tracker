import {
  cameraImageUrl,
  highwayCameraSchema,
  isFerryCamera,
  type HighwayCamera,
  type TerminalCameraView,
} from '@ferry-tracker/shared';
import { z } from 'zod';
import type { WsdotClient } from './wsdotClient.js';

/** The camera inventory changes on the order of months, so it is refreshed on the reference-data cadence. */
const CAMERA_TTL_MS = 21_600_000;
/** A failed refresh keeps serving the previous list and tries again well before the full TTL. */
const CAMERA_RETRY_MS = 300_000;
/** Observed worst legitimate camera-to-terminal distance is 2.9 km, so 5 km leaves headroom without inviting a wrong terminal. */
const MAX_ASSIGN_DISTANCE_KM = 5;
const EARTH_RADIUS_KM = 6371;

/** Hand-curated escape hatch for a camera the automatic rules place on the wrong terminal. */
const CAMERA_TERMINAL_OVERRIDES: Record<number, number> = {};

export interface CameraTerminal {
  id: number;
  name: string;
  latitude: number | null;
  longitude: number | null;
}

const normalize = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** "Bainbridge Island" has to match a title that only says "Bainbridge", so the island suffix is optional. */
function terminalLabels(name: string): string[] {
  const full = normalize(name);
  const withoutIsland = full.replace(/ island$/, '');
  return withoutIsland === full ? [full] : [full, withoutIsland];
}

function containsLabel(title: string, label: string): boolean {
  if (label === '') return false;
  return ` ${title} `.includes(` ${label} `);
}

/**
 * Titles name their terminal more reliably than coordinates do, but only when exactly one terminal
 * is named. "WSF Seattle Ferry Bainbridge Holding" names two, so it falls through to proximity.
 */
function terminalByTitle(title: string, terminals: CameraTerminal[]): number | null {
  const normalized = normalize(title);
  const matches = terminals.filter((terminal) => terminalLabels(terminal.name).some((label) => containsLabel(normalized, label)));
  return matches.length === 1 ? matches[0].id : null;
}

function distanceKm(latitude: number, longitude: number, terminalLatitude: number, terminalLongitude: number): number {
  const latRadians = (latitude * Math.PI) / 180;
  const dLat = (terminalLatitude - latitude) * (Math.PI / 180);
  const dLon = (terminalLongitude - longitude) * (Math.PI / 180);
  const x = dLon * Math.cos(latRadians);
  return Math.sqrt(dLat * dLat + x * x) * EARTH_RADIUS_KM;
}

function terminalByProximity(latitude: number, longitude: number, terminals: CameraTerminal[]): number | null {
  let best: number | null = null;
  let bestDistance = MAX_ASSIGN_DISTANCE_KM;
  for (const terminal of terminals) {
    if (terminal.latitude === null || terminal.longitude === null) continue;
    const distance = distanceKm(latitude, longitude, terminal.latitude, terminal.longitude);
    if (distance <= bestDistance) {
      best = terminal.id;
      bestDistance = distance;
    }
  }
  return best;
}

function cameraPosition(camera: HighwayCamera): { latitude: number; longitude: number } | null {
  const latitude = camera.CameraLocation?.Latitude ?? camera.DisplayLatitude;
  const longitude = camera.CameraLocation?.Longitude ?? camera.DisplayLongitude;
  return typeof latitude === 'number' && typeof longitude === 'number' ? { latitude, longitude } : null;
}

export function assignCameras(cameras: HighwayCamera[], terminals: CameraTerminal[]): Map<number, TerminalCameraView[]> {
  const assigned = new Map<number, TerminalCameraView[]>();
  const order = new Map<number, number>();

  for (const camera of cameras) {
    if (camera.IsActive === false) continue;
    if (!isFerryCamera(camera)) continue;
    const imageUrl = cameraImageUrl(camera.ImageURL);
    if (imageUrl === null) continue;

    const title = camera.Title?.trim() || `Camera ${camera.CameraID}`;
    const position = cameraPosition(camera);
    const terminalId = CAMERA_TERMINAL_OVERRIDES[camera.CameraID]
      ?? terminalByTitle(title, terminals)
      ?? (position ? terminalByProximity(position.latitude, position.longitude, terminals) : null);
    if (terminalId === null) continue;

    const list = assigned.get(terminalId) ?? [];
    list.push({
      id: camera.CameraID,
      title,
      description: camera.Description?.trim() || null,
      imageUrl,
      width: camera.ImageWidth ?? null,
      height: camera.ImageHeight ?? null,
    });
    assigned.set(terminalId, list);
    order.set(camera.CameraID, camera.SortOrder ?? Number.MAX_SAFE_INTEGER);
  }

  for (const list of assigned.values()) {
    list.sort((left, right) => (order.get(left.id)! - order.get(right.id)!) || left.title.localeCompare(right.title));
  }
  return assigned;
}

/**
 * Owns the camera inventory so a terminal request never pays for a 1,700-record fetch and parse.
 * Only a cold cache waits on the network; after that a stale list answers while a single-flight
 * refresh runs behind it, and a failed refresh leaves the previous list in place.
 */
export class CameraDirectory {
  private cameras: HighwayCamera[] = [];
  private expiresAt = 0;
  private inFlight: Promise<HighwayCamera[]> | null = null;

  constructor(private readonly client: WsdotClient, private readonly now: () => number = Date.now) {}

  async list(): Promise<HighwayCamera[]> {
    if (this.now() < this.expiresAt) return this.cameras;
    const cold = this.expiresAt === 0;
    const refresh = this.refresh();
    return cold ? refresh : this.cameras;
  }

  warm(): void {
    if (this.expiresAt === 0) void this.refresh();
  }

  private refresh(): Promise<HighwayCamera[]> {
    this.inFlight ??= this.load().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  private async load(): Promise<HighwayCamera[]> {
    try {
      const raw = await this.client.getHighwayCameras();
      this.cameras = z.array(highwayCameraSchema).parse(raw).filter(isFerryCamera);
      this.expiresAt = this.now() + CAMERA_TTL_MS;
    } catch {
      // Cameras are decoration; a failure here must never stop terminals from rendering.
      this.expiresAt = this.now() + CAMERA_RETRY_MS;
    }
    return this.cameras;
  }
}
