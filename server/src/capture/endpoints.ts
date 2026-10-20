/**
 * Archive filenames are built only from these ids, never from endpoint text, so a
 * WSDOT response can never steer a write outside the archive directory.
 */
export const endpointIds = [
    'vessel_locations',
    'terminal_sailing_space',
    'vessel_basics',
    'terminal_locations',
    'terminal_mates',
    'schedule_today',
] as const;

export type EndpointId = (typeof endpointIds)[number];

const known = new Set<string>(endpointIds);

export function isEndpointId(value: string): value is EndpointId {
    return known.has(value);
}
