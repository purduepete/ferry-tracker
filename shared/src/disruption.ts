import type { SailingView, VesselView } from './wsdot.js';
import {
    DEFAULT_SETTINGS,
    crossingFor,
    minutesFromClock,
    projectedArrival,
    vesselEta,
    type Crossings,
    type FerrySettings,
} from './catch.js';

export const BAINBRIDGE_TERMINAL_ID = 3;
export const SEATTLE_TERMINAL_ID = 7;
export type ArrivalSource = 'median' | 'feed' | 'clock';
export interface ArrivalEstimate {
    at: string;
    source: ArrivalSource;
}

export function estimatedArrival(
    departedAt: string | null | undefined,
    medianMinutes: number | null,
    vessel: Pick<VesselView, 'eta' | 'leftDock' | 'scheduledDeparture'>,
    now: number
): ArrivalEstimate | null {
    const projected = projectedArrival(departedAt, medianMinutes);
    if (projected === null) {
        const live = vesselEta(vessel) ?? vessel.eta;
        return live === null ? null : { at: live, source: 'feed' };
    }
    if (Date.parse(projected) >= now) return { at: projected, source: 'median' };
    const tracked = vessel.eta === null ? Number.NaN : Date.parse(vessel.eta);
    if (tracked >= now) return { at: vessel.eta as string, source: 'feed' };
    return { at: new Date(now).toISOString(), source: 'clock' };
}

export function vesselArrival(
    vessel: Pick<VesselView, 'eta' | 'leftDock' | 'scheduledDeparture' | 'arrivingTerminalId'> &
        Partial<Pick<VesselView, 'departingTerminalId'>>,
    crossings: Crossings = new Map(),
    now: number = Date.now()
): ArrivalEstimate | null {
    const crossing = crossingFor(crossings, vessel.departingTerminalId, vessel.arrivingTerminalId);
    return estimatedArrival(vessel.leftDock, crossing?.medianMinutes ?? null, vessel, now);
}

export interface DisruptionWave {
    vesselId: number | null;
    vesselName: string;
    source: 'observed' | 'live' | 'schedule';
    landingAt: string;
    disruptionAt: string;
    clearsAt: string;
    minutesAway: number;
    minutesLeft: number;
    active: boolean;
    ongoing: boolean;
}

export function disruptionLevel(minutesAway: number, settings: FerrySettings = DEFAULT_SETTINGS) {
    return minutesAway < settings.disruptionImminentMinutes
        ? 'imminent'
        : minutesAway < settings.disruptionSoonMinutes
          ? 'soon'
          : 'clear';
}

const DISRUPTION_MERGE_MINUTES = 30;
const BAINBRIDGE_CROSSING_MINUTES = 35;

function disruptionWave(
    vesselId: number | null,
    vesselName: string,
    landing: number,
    now: number,
    settings: FerrySettings,
    source: DisruptionWave['source'],
    includeEnded = false
): DisruptionWave[] {
    const disruption = landing + settings.disruptionLeadMinutes * 60000;
    const clears = disruption + settings.disruptionDurationMinutes * 60000;
    if (!includeEnded && clears <= now) return [];
    return [
        {
            vesselId,
            vesselName,
            source,
            landingAt: new Date(landing).toISOString(),
            disruptionAt: new Date(disruption).toISOString(),
            clearsAt: new Date(clears).toISOString(),
            minutesAway: minutesFromClock(disruption, now),
            minutesLeft: Math.max(0, minutesFromClock(clears, now)),
            active: disruption <= now,
            ongoing: false,
        },
    ];
}

export function disruptionWaves(
    vessels: Array<
        Pick<VesselView, 'id' | 'name' | 'arrivingTerminalId' | 'atDock' | 'eta' | 'leftDock' | 'scheduledDeparture'> &
            Partial<Pick<VesselView, 'departingTerminalId'>>
    >,
    now: number,
    settings: FerrySettings = DEFAULT_SETTINGS,
    landed: Array<
        Pick<SailingView, 'vesselId' | 'vesselName' | 'actualArrival'> &
            Partial<
                Pick<
                    SailingView,
                    'departingTime' | 'arrivingTime' | 'isCancelled' | 'departingTerminalId' | 'arrivingTerminalId'
                >
            >
    > = [],
    crossings: Crossings = new Map(),
    includeEnded = false
): DisruptionWave[] {
    const crossingMinutes =
        crossingFor(crossings, SEATTLE_TERMINAL_ID, BAINBRIDGE_TERMINAL_ID)?.medianMinutes ??
        BAINBRIDGE_CROSSING_MINUTES;
    const inbound = landed.filter(
        (leg) =>
            !leg.isCancelled &&
            (leg.departingTerminalId == null || leg.departingTerminalId === SEATTLE_TERMINAL_ID) &&
            (leg.arrivingTerminalId == null || leg.arrivingTerminalId === BAINBRIDGE_TERMINAL_ID)
    );
    const observed = inbound.flatMap((leg) => {
        if (!leg.actualArrival) return [];
        const landing = Date.parse(leg.actualArrival);
        if (Number.isNaN(landing)) return [];
        return disruptionWave(
            leg.vesselId,
            leg.vesselName ?? 'Ferry',
            landing,
            now,
            settings,
            'observed',
            includeEnded
        );
    });
    const underway = vessels.flatMap((vessel) => {
        if (vessel.arrivingTerminalId !== BAINBRIDGE_TERMINAL_ID || vessel.atDock !== false || !vessel.eta) return [];
        const landing = Date.parse(vesselArrival(vessel, crossings, now)?.at ?? vessel.eta);
        if (Number.isNaN(landing)) return [];
        const duplicate = observed.some(
            (seen) =>
                seen.vesselId === vessel.id &&
                Math.abs(Date.parse(seen.landingAt) - landing) < DISRUPTION_MERGE_MINUTES * 60000
        );
        return duplicate ? [] : disruptionWave(vessel.id, vessel.name, landing, now, settings, 'live', includeEnded);
    });
    const scheduled = inbound.flatMap((leg) => {
        if (leg.actualArrival && Number.isFinite(Date.parse(leg.actualArrival))) return [];
        const departure = leg.departingTime ? Date.parse(leg.departingTime) : NaN;
        if (!Number.isFinite(departure)) return [];
        const publishedArrival = leg.arrivingTime ? Date.parse(leg.arrivingTime) : NaN;
        const landing =
            Number.isFinite(publishedArrival) && publishedArrival > departure
                ? publishedArrival
                : departure + crossingMinutes * 60000;
        const uniqueSlot =
            inbound.filter((candidate) => candidate.departingTime && Date.parse(candidate.departingTime) === departure)
                .length === 1;
        const live = vessels.find(
            (vessel) =>
                vessel.arrivingTerminalId === BAINBRIDGE_TERMINAL_ID &&
                vessel.atDock === false &&
                vessel.eta &&
                Number.isFinite(Date.parse(vesselArrival(vessel, crossings, now)?.at ?? vessel.eta)) &&
                ((vessel.scheduledDeparture &&
                    Date.parse(vessel.scheduledDeparture) === departure &&
                    (vessel.id === leg.vesselId ||
                        (uniqueSlot && vessel.departingTerminalId === SEATTLE_TERMINAL_ID))) ||
                    (vessel.id === leg.vesselId &&
                        !vessel.scheduledDeparture &&
                        Math.abs(Date.parse(vesselArrival(vessel, crossings, now)?.at ?? vessel.eta) - landing) <
                            DISRUPTION_MERGE_MINUTES * 60000))
        );
        if (live) return [];
        return disruptionWave(
            leg.vesselId,
            leg.vesselName ?? 'Ferry',
            landing,
            now,
            settings,
            'schedule',
            includeEnded
        );
    });
    const waves = [...observed, ...underway, ...scheduled].sort((left, right) =>
        left.disruptionAt.localeCompare(right.disruptionAt)
    );
    for (const [index, wave] of waves.entries()) {
        wave.ongoing = waves[index + 1] !== undefined && waves[index + 1].disruptionAt <= wave.clearsAt;
    }
    return waves;
}
