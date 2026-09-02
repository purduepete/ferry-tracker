const ACCESS_CODE_PARAM = /([?&](?:apiaccesscode)=)[^&\s"']+/gi;

/**
 * Strips the WSDOT access code from anything that leaves the process or lands on disk.
 * The Express error middleware only covers HTTP responses, so capture errors, archive
 * bodies, log lines and the status payload all route through here instead.
 */
export function redactSecrets(value: unknown, secret?: string): string {
  const text = toText(value);
  const withoutParam = text.replace(ACCESS_CODE_PARAM, '$1[redacted]');
  return secret ? withoutParam.replaceAll(secret, '[redacted]') : withoutParam;
}

function toText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack ? `${value.message}\n${value.stack}` : value.message;
  if (value === null || value === undefined) return '';
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
