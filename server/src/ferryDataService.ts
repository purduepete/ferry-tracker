import {
  parseWsdotDate,
  spaceCount,
  terminalSailingSpaceSchema,
  terminalMateSchema,
  terminalBasicSchema,
  terminalLocationSchema,
  vesselBasicSchema,
  vesselLocationSchema,
  type SailingView,
  type SailingSpaceView,
  type SourceRecord,
  type TerminalView,
  type TerminalMateView,
  type VesselView,
} from '@ferry-tracker/shared';
import { z } from 'zod';
import type { RecordedLeg, RecordedSpace, SailingHistory } from './history/sailingHistory.js';
import type { WsdotClient } from './wsdotClient.js';

const asRecord = (value: unknown): SourceRecord | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as SourceRecord : null;
const numberValue = (value: unknown): number | null => typeof value === 'number' ? value : null;
const stringValue = (value: unknown): string | null => typeof value === 'string' ? value : null;
const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;

export function isScheduleVisible(departingTime: string | null, now: number): boolean {
  if (departingTime === null) return true;
  const departure = Date.parse(departingTime);
  return Number.isNaN(departure) || (departure >= now - TWO_HOURS_MS && departure <= now + TWELVE_HOURS_MS);
}

// Capture only stands in where the live feed gave nothing, so an upcoming sailing always wins.
function backfill(
  sailing: SailingView,
  recorded: Map<string, RecordedSpace> | undefined,
  legs: Map<string, RecordedLeg> | undefined,
  departingId: number,
  arrivingId: number,
): SailingView {
  if (sailing.departingTime === null) return sailing;
  if (sailing.departingTerminalId !== null && sailing.departingTerminalId !== departingId) return sailing;
  if (sailing.arrivingTerminalId !== null && sailing.arrivingTerminalId !== arrivingId) return sailing;

  const leg = legs?.get(sailing.departingTime);
  const withLeg: SailingView = leg === undefined ? sailing : {
    ...sailing,
    actualDeparture: leg.actualDeparture,
    departureDelayMinutes: leg.departureDelayMinutes,
  };

  const match = withLeg.spaceAvailable ? undefined : recorded?.get(sailing.departingTime);
  if (match === undefined) return withLeg;
  return {
    ...withLeg,
    isCancelled: withLeg.isCancelled ?? match.isCancelled,
    driveUpSpaceCount: match.driveUpSpaceCount,
    reservableSpaceCount: match.reservableSpaceCount,
    maxSpaceCount: match.maxSpaceCount,
    spaceAvailable: true,
    spaceSource: 'recorded',
    spaceObservedAt: match.observedAt,
    spaceLeadSeconds: match.leadSeconds,
  };
}

export class FerryDataService {
  constructor(
    private readonly client: WsdotClient,
    private readonly now: () => number = Date.now,
    private readonly history?: SailingHistory,
  ) {}

  async terminals(): Promise<{ data: TerminalView[]; raw: unknown }> {
    const [basicsRaw, locationsRaw] = await Promise.all([this.client.getTerminalBasics(), this.client.getTerminalLocations()]);
    const basics = z.array(terminalBasicSchema).parse(basicsRaw);
    const locations = z.array(terminalLocationSchema).parse(locationsRaw);
    const locationsById = new Map(locations.map((location) => [location.TerminalID, location]));
    const data = basics.map<TerminalView>((basic) => {
      const location = locationsById.get(basic.TerminalID);
      return {
        id: basic.TerminalID,
        name: basic.TerminalName,
        subjectName: basic.TerminalSubjectName ?? null,
        latitude: location?.Latitude ?? null,
        longitude: location?.Longitude ?? null,
        city: location?.City ?? null,
        raw: [basic, ...(location ? [location] : [])] as SourceRecord[],
      };
    }).sort((left, right) => left.name.localeCompare(right.name));
    return { data, raw: { basics: basicsRaw, locations: locationsRaw } };
  }

  async vessels(): Promise<{ data: VesselView[]; raw: unknown }> {
    const [basicsRaw, locationsRaw] = await Promise.all([this.client.getVesselBasics(), this.client.getVesselLocations()]);
    const basics = z.array(vesselBasicSchema).parse(basicsRaw);
    const locations = z.array(vesselLocationSchema).parse(locationsRaw);
    const basicsById = new Map(basics.map((basic) => [basic.VesselID, basic]));
    const data = locations.map<VesselView>((location) => {
      const basic = basicsById.get(location.VesselID);
      return {
        id: location.VesselID,
        name: location.VesselName,
        vesselClass: basic?.Class?.PublicDisplayName ?? basic?.Class?.ClassName ?? null,
        departingTerminalId: location.DepartingTerminalID ?? null,
        arrivingTerminalId: location.ArrivingTerminalID ?? null,
        departingTerminalName: location.DepartingTerminalName ?? null,
        arrivingTerminalName: location.ArrivingTerminalName ?? null,
        latitude: location.Latitude ?? null,
        longitude: location.Longitude ?? null,
        speed: location.Speed ?? null,
        heading: location.Heading ?? null,
        inService: location.InService ?? null,
        atDock: location.AtDock ?? null,
        leftDock: parseWsdotDate(location.LeftDock),
        eta: parseWsdotDate(location.Eta),
        etaBasis: location.EtaBasis ?? null,
        scheduledDeparture: parseWsdotDate(location.ScheduledDeparture),
        updatedAt: parseWsdotDate(location.TimeStamp),
        raw: [location, ...(basic ? [basic] : [])] as SourceRecord[],
      };
    }).sort((left, right) => left.name.localeCompare(right.name));
    return { data, raw: { basics: basicsRaw, locations: locationsRaw } };
  }

  async terminalMates(): Promise<{ data: TerminalMateView[]; raw: unknown }> {
    const raw = await this.client.getTerminalMates();
    const mates = z.array(terminalMateSchema).parse(raw);
    return {
      data: mates.map((mate) => ({
        departingTerminalId: mate.DepartingTerminalID,
        departingTerminalName: mate.DepartingDescription,
        arrivingTerminalId: mate.ArrivingTerminalID,
        arrivingTerminalName: mate.ArrivingDescription,
      })),
      raw,
    };
  }

  async sailingSpaces(departingId: number, arrivingId: number): Promise<{ data: SailingSpaceView[]; raw: unknown }> {
    const raw = await this.client.getTerminalSailingSpaces();
    const terminals = z.array(terminalSailingSpaceSchema).parse(raw);
    const data = terminals
      .filter((terminal) => terminal.TerminalID === departingId)
      .flatMap((terminal) => terminal.DepartingSpaces.flatMap((departure) =>
        departure.SpaceForArrivalTerminals
          .filter((space) => space.TerminalID === arrivingId || space.ArrivalTerminalIDs.includes(arrivingId))
          .map<SailingSpaceView>((space) => ({
            departingTerminalId: terminal.TerminalID,
            departingTerminalName: terminal.TerminalName,
            arrivingTerminalId: space.TerminalID,
            arrivingTerminalName: space.TerminalName,
            departure: parseWsdotDate(departure.Departure) ?? departure.Departure,
            vesselId: departure.VesselID,
            vesselName: departure.VesselName,
            isCancelled: departure.IsCancelled,
            driveUpSpaceCount: space.DisplayDriveUpSpace ? spaceCount(space.DriveUpSpaceCount) : null,
            reservableSpaceCount: space.DisplayReservableSpace ? spaceCount(space.ReservableSpaceCount) : null,
            maxSpaceCount: spaceCount(space.MaxSpaceCount ?? departure.MaxSpaceCount),
          })),
      ))
      .sort((left, right) => left.departure.localeCompare(right.departure));
    return { data, raw };
  }

  async schedule(departingId: number, arrivingId: number, _onlyRemaining: boolean): Promise<{ data: SailingView[]; raw: unknown }> {
    const now = this.now();
    const windowStart = now - TWO_HOURS_MS;
    const windowEnd = now + TWELVE_HOURS_MS;
    const [raw, spacesRaw] = await Promise.all([
      this.client.getScheduleRange(departingId, arrivingId, windowStart, windowEnd),
      this.client.getTerminalSailingSpaces(),
    ]);
    const spaces = z.array(terminalSailingSpaceSchema).parse(spacesRaw);
    const sailings: SailingView[] = [];

    const visit = (value: unknown, context: { departingId: number | null; arrivingId: number | null }): void => {
      if (Array.isArray(value)) {
        value.forEach((item) => visit(item, context));
        return;
      }
      const record = asRecord(value);
      if (!record) return;
      const nextContext = {
        departingId: numberValue(record.DepartingTerminalID) ?? context.departingId,
        arrivingId: numberValue(record.ArrivingTerminalID) ?? context.arrivingId,
      };
      if ('DepartingTime' in record || 'ScheduledDeparture' in record) {
        const departingTime = parseWsdotDate(record.DepartingTime ?? record.ScheduledDeparture);
        const vesselId = numberValue(record.VesselID);
        const departureSpace = spaces
          .find((terminal) => terminal.TerminalID === nextContext.departingId)
          ?.DepartingSpaces.find((space) => space.VesselID === vesselId && parseWsdotDate(space.Departure) === departingTime);
        const destinationSpace = departureSpace?.SpaceForArrivalTerminals.find((space) =>
          nextContext.arrivingId !== null && (space.TerminalID === nextContext.arrivingId || space.ArrivalTerminalIDs.includes(nextContext.arrivingId)),
        );
        sailings.push({
          vesselId,
          vesselName: stringValue(record.VesselName),
          departingTime,
          arrivingTime: parseWsdotDate(record.ArrivingTime ?? record.ScheduledArrival),
          departingTerminalId: nextContext.departingId,
          arrivingTerminalId: nextContext.arrivingId,
          isCancelled: departureSpace?.IsCancelled ?? null,
          driveUpSpaceCount: destinationSpace?.DisplayDriveUpSpace ? spaceCount(destinationSpace.DriveUpSpaceCount) : null,
          reservableSpaceCount: destinationSpace?.DisplayReservableSpace ? spaceCount(destinationSpace.ReservableSpaceCount) : null,
          maxSpaceCount: spaceCount(destinationSpace?.MaxSpaceCount ?? departureSpace?.MaxSpaceCount),
          spaceAvailable: destinationSpace !== undefined,
          spaceSource: destinationSpace === undefined ? null : 'live',
          spaceObservedAt: null,
          spaceLeadSeconds: null,
          actualDeparture: null,
          departureDelayMinutes: null,
          raw: record,
        });
      }
      Object.values(record).forEach((child) => visit(child, nextContext));
    };

    visit(raw, { departingId, arrivingId });
    const visible = sailings.filter((sailing) => isScheduleVisible(sailing.departingTime, now));
    const fromIso = new Date(windowStart).toISOString();
    const toIso = new Date(windowEnd).toISOString();
    const recorded = visible.some((sailing) => !sailing.spaceAvailable)
      ? this.history?.recordedSpaces(departingId, arrivingId, fromIso, toIso)
      : undefined;
    const legs = this.history?.recordedLegs(departingId, arrivingId, fromIso, toIso);
    return {
      data: visible
        .map((sailing) => backfill(sailing, recorded, legs, departingId, arrivingId))
        .sort((left, right) => (left.departingTime ?? '').localeCompare(right.departingTime ?? '')),
      raw: { schedule: raw, sailingSpace: spacesRaw },
    };
  }
}