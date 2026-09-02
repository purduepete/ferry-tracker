import type { ApiEnvelope, SailingSpaceView, SailingView, TerminalMateView, TerminalView, VesselView } from '@ferry-tracker/shared';

async function get<T>(path: string, signal?: AbortSignal): Promise<ApiEnvelope<T>> {
  const response = await fetch(path, { signal });
  const body = await response.json() as ApiEnvelope<T> | { error: string };
  if (!response.ok) throw new Error('error' in body ? body.error : `Request failed with HTTP ${response.status}.`);
  return body as ApiEnvelope<T>;
}

export const ferryApi = {
  terminals: (signal?: AbortSignal) => get<TerminalView[]>('/api/terminals', signal),
  vessels: (signal?: AbortSignal) => get<VesselView[]>('/api/vessels', signal),
  terminalMates: (signal?: AbortSignal) => get<TerminalMateView[]>('/api/terminal-mates', signal),
  sailingSpaces: (departingId: number, arrivingId: number, signal?: AbortSignal) =>
    get<SailingSpaceView[]>(`/api/sailing-spaces?departingTerminalId=${departingId}&arrivingTerminalId=${arrivingId}`, signal),
  schedule: (departingId: number, arrivingId: number, signal?: AbortSignal) =>
    get<SailingView[]>(`/api/schedule?departingTerminalId=${departingId}&arrivingTerminalId=${arrivingId}&onlyRemaining=false`, signal),
};