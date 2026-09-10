import { z } from 'zod';

const nullableNumber = z.number().nullable().optional();
const nullableString = z.string().nullable().optional();

export const terminalBasicSchema = z.looseObject({
  TerminalID: z.number(),
  TerminalName: z.string(),
  TerminalSubjectName: nullableString,
  RegionID: nullableNumber,
  SortOrder: nullableNumber,
});

export const terminalLocationSchema = z.looseObject({
  TerminalID: z.number(),
  TerminalName: nullableString,
  Latitude: nullableNumber,
  Longitude: nullableNumber,
  AddressLineOne: nullableString,
  City: nullableString,
  State: nullableString,
  ZipCode: nullableString,
});

export const vesselBasicSchema = z.looseObject({
  VesselID: z.number(),
  VesselName: z.string(),
  Class: z.looseObject({
    ClassID: z.number(),
    ClassName: z.string(),
    PublicDisplayName: nullableString,
  }).nullable().optional(),
  MaxPassengers: nullableNumber,
  MaxVehicles: nullableNumber,
  Status: nullableNumber,
});

export const vesselLocationSchema = z.looseObject({
  VesselID: z.number(),
  VesselName: z.string(),
  DepartingTerminalID: nullableNumber,
  DepartingTerminalName: nullableString,
  ArrivingTerminalID: nullableNumber,
  ArrivingTerminalName: nullableString,
  Latitude: nullableNumber,
  Longitude: nullableNumber,
  Speed: nullableNumber,
  Heading: nullableNumber,
  InService: z.boolean().nullable().optional(),
  AtDock: z.boolean().nullable().optional(),
  LeftDock: nullableString,
  Eta: nullableString,
  EtaBasis: nullableString,
  OpRouteAbbrev: z.array(z.string()).nullable().optional(),
  ScheduledDeparture: nullableString,
  TimeStamp: nullableString,
});

export type SourceRecord = Record<string, unknown>;
export type TerminalBasic = z.infer<typeof terminalBasicSchema>;
export type TerminalLocation = z.infer<typeof terminalLocationSchema>;
export type VesselBasic = z.infer<typeof vesselBasicSchema>;
export type VesselLocation = z.infer<typeof vesselLocationSchema>;

export const terminalSailingSpaceSchema = z.looseObject({
  TerminalID: z.number(),
  TerminalName: z.string(),
  DepartingSpaces: z.array(z.looseObject({
    Departure: z.string(),
    IsCancelled: z.boolean(),
    VesselID: z.number(),
    VesselName: z.string(),
    MaxSpaceCount: z.number().nullable().optional(),
    SpaceForArrivalTerminals: z.array(z.looseObject({
      TerminalID: z.number(),
      TerminalName: z.string(),
      VesselID: z.number(),
      VesselName: z.string(),
      DisplayReservableSpace: z.boolean(),
      ReservableSpaceCount: z.number().nullable().optional(),
      DisplayDriveUpSpace: z.boolean(),
      DriveUpSpaceCount: z.number().nullable().optional(),
      MaxSpaceCount: z.number().nullable().optional(),
      ArrivalTerminalIDs: z.array(z.number()),
    })),
  })),
});

export const terminalMateSchema = z.looseObject({
  DepartingTerminalID: z.number(),
  DepartingDescription: z.string(),
  ArrivingTerminalID: z.number(),
  ArrivingDescription: z.string(),
});

export type TerminalMate = z.infer<typeof terminalMateSchema>;

export const scheduleTimeSchema = z.looseObject({
  DepartingTime: z.string(),
  ArrivingTime: nullableString,
  VesselID: nullableNumber,
  VesselName: nullableString,
  LoadingRule: nullableNumber,
});

export const terminalComboSchema = z.looseObject({
  DepartingTerminalID: z.number(),
  DepartingTerminalName: nullableString,
  ArrivingTerminalID: z.number(),
  ArrivingTerminalName: nullableString,
  Times: z.array(scheduleTimeSchema),
});

/** Validates the parent shape so a sailing can never be stored without its terminal pair. */
export const scheduleResponseSchema = z.looseObject({
  ScheduleID: nullableNumber,
  TerminalCombos: z.array(terminalComboSchema),
});

export type ScheduleResponse = z.infer<typeof scheduleResponseSchema>;

export interface TerminalMateView {
  departingTerminalId: number;
  departingTerminalName: string;
  arrivingTerminalId: number;
  arrivingTerminalName: string;
}

export interface TerminalView {
  id: number;
  name: string;
  subjectName: string | null;
  latitude: number | null;
  longitude: number | null;
  city: string | null;
  cameras: TerminalCameraView[];
  raw: SourceRecord[];
}

export const highwayCameraSchema = z.looseObject({
  CameraID: z.number(),
  Title: nullableString,
  Description: nullableString,
  ImageURL: nullableString,
  ImageWidth: nullableNumber,
  ImageHeight: nullableNumber,
  IsActive: z.boolean().nullable().optional(),
  SortOrder: nullableNumber,
  DisplayLatitude: nullableNumber,
  DisplayLongitude: nullableNumber,
  CameraLocation: z.looseObject({
    Latitude: nullableNumber,
    Longitude: nullableNumber,
    RoadName: nullableString,
  }).nullable().optional(),
});

export type HighwayCamera = z.infer<typeof highwayCameraSchema>;

export interface TerminalCameraView {
  id: number;
  title: string;
  description: string | null;
  imageUrl: string;
  width: number | null;
  height: number | null;
}

export const CAMERA_IMAGE_HOST = 'images.wsdot.wa.gov';

// The statewide camera feed carries third-party image hosts, so only WSDOT's own host is trusted.
export function cameraImageUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === CAMERA_IMAGE_HOST ? url.toString() : null;
  } catch {
    return null;
  }
}

export function isFerryCamera(camera: HighwayCamera): boolean {
  return camera.CameraLocation?.RoadName === 'Ferries';
}

export interface VesselView {
  id: number;
  name: string;
  vesselClass: string | null;
  departingTerminalId: number | null;
  arrivingTerminalId: number | null;
  departingTerminalName: string | null;
  arrivingTerminalName: string | null;
  latitude: number | null;
  longitude: number | null;
  speed: number | null;
  heading: number | null;
  inService: boolean | null;
  atDock: boolean | null;
  leftDock: string | null;
  eta: string | null;
  etaBasis: string | null;
  scheduledDeparture: string | null;
  updatedAt: string | null;
  raw: SourceRecord[];
}

export interface SailingView {
  vesselId: number | null;
  vesselName: string | null;
  departingTime: string | null;
  arrivingTime: string | null;
  departingTerminalId: number | null;
  arrivingTerminalId: number | null;
  isCancelled: boolean | null;
  driveUpSpaceCount: number | null;
  reservableSpaceCount: number | null;
  maxSpaceCount: number | null;
  spaceAvailable: boolean;
  // WSDOT drops a departure from the space feed the moment it sails, so a past sailing's
  // counts can only come from capture. Lead time says how stale that last reading was.
  spaceSource: 'live' | 'recorded' | null;
  spaceObservedAt: string | null;
  spaceLeadSeconds: number | null;
  // Only present once a boat has sailed and the rollup vouched for the leg. WSDOT almost
  // never publishes arrivingTime, so the observed dock arrival is the usual source.
  actualDeparture: string | null;
  actualArrival: string | null;
  departureDelayMinutes: number | null;
  raw: SourceRecord;
}

export interface SailingSpaceView {
  departingTerminalId: number;
  departingTerminalName: string;
  arrivingTerminalId: number;
  arrivingTerminalName: string;
  departure: string;
  vesselId: number;
  vesselName: string;
  isCancelled: boolean;
  driveUpSpaceCount: number | null;
  reservableSpaceCount: number | null;
  maxSpaceCount: number | null;
}

export interface ApiEnvelope<T> {
  data: T;
  fetchedAt: string;
  source: 'live' | 'fixture';
  raw: unknown;
}

export function parseWsdotDate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = /^\/Date\((-?\d+)(?:[+-]\d{4})?\)\/$/.exec(value);
  if (match) return new Date(Number(match[1])).toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? null : parsed.toISOString();
}

// WSDOT oversells a boat and then publishes the overage as a negative count.
export function spaceCount(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return Math.max(0, value);
}