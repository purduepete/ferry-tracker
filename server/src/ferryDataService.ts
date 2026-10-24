import {
    catchWindowLevel,
    catchWindows as computeCatchWindows,
    crossingKey,
    pacificParts,
    parseWsdotDate,
    spaceCount,
    terminalSailingSpaceSchema,
    terminalMateSchema,
    terminalBasicSchema,
    terminalLocationSchema,
    vesselBasicSchema,
    vesselLocationSchema,
    type CatchTiming,
    type CatchWindow,
    type Crossings,
    type SailingView,
    type SailingSpaceView,
    type SourceRecord,
    type TerminalView,
    type TerminalMateView,
    type VesselView,
} from '@ferry-tracker/shared';
import { z } from 'zod';
import { AlertDirectory, assignAlerts, RouteDirectory } from './alerts.js';
import { assignCameras, CameraDirectory } from './cameras.js';
import type { RecordedLeg, RecordedSpace, SailingHistory } from './history/sailingHistory.js';
import type { WsdotClient } from './wsdotClient.js';

const asRecord = (value: unknown): SourceRecord | null =>
    value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as SourceRecord) : null;
const numberValue = (value: unknown): number | null => (typeof value === 'number' ? value : null);
const stringValue = (value: unknown): string | null => (typeof value === 'string' ? value : null);
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
    arrivingId: number
): SailingView {
    if (sailing.departingTime === null) return sailing;
    if (sailing.departingTerminalId !== null && sailing.departingTerminalId !== departingId) return sailing;
    if (sailing.arrivingTerminalId !== null && sailing.arrivingTerminalId !== arrivingId) return sailing;

    const leg = legs?.get(sailing.departingTime);
    const withLeg: SailingView =
        leg === undefined
            ? sailing
            : {
                  ...sailing,
                  actualDeparture: leg.actualDeparture,
                  actualArrival: leg.actualArrival,
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

export interface CatchAnswer {
    summary: string;
    windows: CatchWindow[];
}

// Pacific, not the server's zone, because the reader is standing in a ferry queue in Washington.
function pacificClock(iso: string): string {
    const parts = pacificParts(iso);
    return parts === null
        ? '??:??'
        : `${String(parts.hourLocal).padStart(2, '0')}:${String(parts.minuteLocal).padStart(2, '0')}`;
}

// One line, read on a watch face at arm's length, so it names the next boat and nothing else.
export function catchSummary(windows: CatchWindow[]): string {
    const next = windows[0];
    if (next === undefined) return 'No sailings you can still catch.';

    const boat = next.vesselName
        ? `${pacificClock(next.departureAt)} ${next.vesselName}`
        : `${pacificClock(next.departureAt)} boat`;
    const delayed = next.expectedDepartureAt === null ? '' : ` (exp ${pacificClock(next.expectedDepartureAt)})`;
    const queueLeft =
        next.estimatedMinutesAway === null ? next.queueMinutesRemaining : next.estimatedQueueMinutesRemaining;
    const leaveBy = next.estimatedLeaveByAt ?? next.leaveByAt;
    const minutesAway = next.estimatedMinutesAway ?? next.minutesAway;
    const body =
        queueLeft === null
            ? `Leave by ${pacificClock(leaveBy)} for the ${boat}${delayed}, ${minutesAway} min`
            : `Leave now for the ${boat}${delayed}, ${queueLeft} min of queue left`;

    // The marker carries the same warning the Catch tab paints red, which a one-line string cannot.
    return catchWindowLevel(next) === 'imminent' ? `! ${body}` : body;
}

export class FerryDataService {
    private readonly cameras: CameraDirectory;
    private readonly alerts: AlertDirectory;
    private readonly routes: RouteDirectory;

    constructor(
        private readonly client: WsdotClient,
        private readonly now: () => number = Date.now,
        private readonly history?: SailingHistory
    ) {
        this.cameras = new CameraDirectory(client, now);
        this.alerts = new AlertDirectory(client, now);
        this.routes = new RouteDirectory(client, now);
    }

    /** Pulls the camera inventory at startup so the first terminal request does not wait on it. */
    warmCameras(): void {
        this.cameras.warm();
        this.alerts.warm();
        this.routes.warm();
    }

    async terminals(): Promise<{ data: TerminalView[]; raw: unknown }> {
        const [basicsRaw, locationsRaw, cameras, alerts] = await Promise.all([
            this.client.getTerminalBasics(),
            this.client.getTerminalLocations(),
            this.cameras.list(),
            this.alerts.list(),
        ]);
        const basics = z.array(terminalBasicSchema).parse(basicsRaw);
        const locations = z.array(terminalLocationSchema).parse(locationsRaw);
        const locationsById = new Map(locations.map((location) => [location.TerminalID, location]));
        const positions = basics.map((basic) => ({
            id: basic.TerminalID,
            name: basic.TerminalName,
            latitude: locationsById.get(basic.TerminalID)?.Latitude ?? null,
            longitude: locationsById.get(basic.TerminalID)?.Longitude ?? null,
        }));
        const camerasByTerminal = assignCameras(cameras, positions);
        const alertsByTerminal = assignAlerts(alerts, this.routes.list());
        const data = basics
            .map<TerminalView>((basic) => {
                const location = locationsById.get(basic.TerminalID);
                return {
                    id: basic.TerminalID,
                    name: basic.TerminalName,
                    subjectName: basic.TerminalSubjectName ?? null,
                    latitude: location?.Latitude ?? null,
                    longitude: location?.Longitude ?? null,
                    city: location?.City ?? null,
                    cameras: camerasByTerminal.get(basic.TerminalID) ?? [],
                    alerts: alertsByTerminal.get(basic.TerminalID) ?? [],
                    raw: [basic, ...(location ? [location] : [])] as SourceRecord[],
                };
            })
            .sort((left, right) => left.name.localeCompare(right.name));
        // Raw alert bodies stay out of the envelope: the inspector is on by default and the text is HTML.
        return { data, raw: { basics: basicsRaw, locations: locationsRaw } };
    }

    async vessels(fresh = false): Promise<{ data: VesselView[]; raw: unknown }> {
        const [basicsRaw, locationsRaw] = await Promise.all([
            this.client.getVesselBasics(),
            this.client.getVesselLocations(fresh),
        ]);
        const basics = z.array(vesselBasicSchema).parse(basicsRaw);
        const locations = z.array(vesselLocationSchema).parse(locationsRaw);
        const basicsById = new Map(basics.map((basic) => [basic.VesselID, basic]));
        const data = locations
            .map<VesselView>((location) => {
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
            })
            .sort((left, right) => left.name.localeCompare(right.name));
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
            .flatMap((terminal) =>
                terminal.DepartingSpaces.flatMap((departure) =>
                    departure.SpaceForArrivalTerminals.filter(
                        (space) => space.TerminalID === arrivingId || space.ArrivalTerminalIDs.includes(arrivingId)
                    ).map<SailingSpaceView>((space) => ({
                        departingTerminalId: terminal.TerminalID,
                        departingTerminalName: terminal.TerminalName,
                        arrivingTerminalId: space.TerminalID,
                        arrivingTerminalName: space.TerminalName,
                        departure: parseWsdotDate(departure.Departure) ?? departure.Departure,
                        vesselId: departure.VesselID,
                        vesselName: departure.VesselName,
                        isCancelled: departure.IsCancelled,
                        driveUpSpaceCount: space.DisplayDriveUpSpace ? spaceCount(space.DriveUpSpaceCount) : null,
                        reservableSpaceCount: space.DisplayReservableSpace
                            ? spaceCount(space.ReservableSpaceCount)
                            : null,
                        maxSpaceCount: spaceCount(space.MaxSpaceCount ?? departure.MaxSpaceCount),
                    }))
                )
            )
            .sort((left, right) => left.departure.localeCompare(right.departure));
        return { data, raw };
    }

    async schedule(
        departingId: number,
        arrivingId: number,
        _onlyRemaining: boolean,
        fresh = false
    ): Promise<{ data: SailingView[]; raw: unknown }> {
        const now = this.now();
        const windowStart = now - TWO_HOURS_MS;
        const windowEnd = now + TWELVE_HOURS_MS;
        const [raw, spacesRaw] = await Promise.all([
            this.client.getScheduleRange(departingId, arrivingId, windowStart, windowEnd, fresh),
            this.client.getTerminalSailingSpaces(fresh),
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
                    ?.DepartingSpaces.find(
                        (space) => space.VesselID === vesselId && parseWsdotDate(space.Departure) === departingTime
                    );
                const destinationSpace = departureSpace?.SpaceForArrivalTerminals.find(
                    (space) =>
                        nextContext.arrivingId !== null &&
                        (space.TerminalID === nextContext.arrivingId ||
                            space.ArrivalTerminalIDs.includes(nextContext.arrivingId))
                );
                sailings.push({
                    vesselId,
                    vesselName: stringValue(record.VesselName),
                    departingTime,
                    arrivingTime: parseWsdotDate(record.ArrivingTime ?? record.ScheduledArrival),
                    departingTerminalId: nextContext.departingId,
                    arrivingTerminalId: nextContext.arrivingId,
                    isCancelled:
                        departureSpace?.IsCancelled ??
                        (typeof record.IsCancelled === 'boolean' ? record.IsCancelled : null),
                    driveUpSpaceCount: destinationSpace?.DisplayDriveUpSpace
                        ? spaceCount(destinationSpace.DriveUpSpaceCount)
                        : null,
                    reservableSpaceCount: destinationSpace?.DisplayReservableSpace
                        ? spaceCount(destinationSpace.ReservableSpaceCount)
                        : null,
                    maxSpaceCount: spaceCount(destinationSpace?.MaxSpaceCount ?? departureSpace?.MaxSpaceCount),
                    spaceAvailable: destinationSpace !== undefined,
                    spaceSource: destinationSpace === undefined ? null : 'live',
                    spaceObservedAt: null,
                    spaceLeadSeconds: null,
                    actualDeparture: null,
                    actualArrival: null,
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
            ? await this.history?.recordedSpaces(departingId, arrivingId, fromIso, toIso)
            : undefined;
        const legs = await this.history?.recordedLegs(departingId, arrivingId, fromIso, toIso);
        return {
            data: visible
                .map((sailing) => backfill(sailing, recorded, legs, departingId, arrivingId))
                .sort((left, right) => (left.departingTime ?? '').localeCompare(right.departingTime ?? '')),
            raw: { schedule: raw, sailingSpace: spacesRaw },
        };
    }

    async notificationSnapshot(departingId: number, arrivingId: number) {
        const [schedule, vessels, measured] = await Promise.all([
            this.schedule(departingId, arrivingId, false, true),
            this.vessels(true),
            this.history?.crossings(),
        ]);
        const crossings: Crossings = new Map();
        for (const crossing of measured ?? []) {
            const key = crossingKey(crossing.departingTerminalId, crossing.arrivingTerminalId);
            if (key !== null) crossings.set(key, crossing);
        }
        return { sailings: schedule.data, vessels: vessels.data, crossings };
    }

    // The same rules the Catch tab runs, answered server-side so a watch complication can read one
    // line without shipping the schedule, the fleet and the crossing medians to the wrist.
    async catchWindows(
        departingId: number,
        arrivingId: number,
        timing: CatchTiming
    ): Promise<{ data: CatchAnswer; raw: unknown }> {
        const now = this.now();
        const [schedule, vessels] = await Promise.all([this.schedule(departingId, arrivingId, true), this.vessels()]);
        const crossings: Crossings = new Map();
        for (const crossing of (await this.history?.crossings()) ?? []) {
            const key = crossingKey(crossing.departingTerminalId, crossing.arrivingTerminalId);
            if (key !== null) crossings.set(key, crossing);
        }
        const windows = computeCatchWindows(schedule.data, now, timing, vessels.data, crossings);
        // Raw stays null however the inspector is configured: this payload crosses a metered path.
        return { data: { summary: catchSummary(windows), windows }, raw: null };
    }
}
