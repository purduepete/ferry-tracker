import { readFileSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import path from 'node:path';
import type { PoolConfig } from 'pg';

function privateAddress(value: string | null): value is string {
  if (!value || !/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(value)) return false;
  const [a, b, c, d] = value.split('.').map(Number);
  if ([a, b, c, d].some(octet => octet > 255)) return false;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

export function postgresConnection(connectionString: string, readCA: (filename: string) => string = filename => readFileSync(filename, 'utf8')): PoolConfig {
  let url: URL;
  try { url = new URL(connectionString); } catch { throw new Error('Invalid PostgreSQL connection URL.'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('Invalid PostgreSQL connection protocol.');
  if (['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && !url.search) return { connectionString };
  const allowed = ['hostaddr', 'sslmode', 'sslrootcert', 'gssencmode'];
  if (url.hostname !== 'jimbrownhome1' || url.hash ||
      [...url.searchParams.keys()].some(key => !allowed.includes(key)) ||
      allowed.some(key => url.searchParams.getAll(key).length !== 1) ||
      !privateAddress(url.searchParams.get('hostaddr')) ||
      url.searchParams.get('sslmode') !== 'verify-full' ||
      url.searchParams.get('gssencmode') !== 'disable' ||
      !/^\/[a-z][a-z0-9_]*$/.test(url.pathname) || !url.username || !url.password) {
    throw new Error('Remote PostgreSQL requires the approved pinned host and verified TLS policy.');
  }
  const certificatePath = url.searchParams.get('sslrootcert')!;
  if (!path.win32.isAbsolute(certificatePath) || !/^[a-z]:\\/i.test(certificatePath) || certificatePath.includes('\0')) {
    throw new Error('PostgreSQL CA must be an absolute local Windows file.');
  }
  let ca: string;
  try {
    ca = readCA(certificatePath);
    if (!new X509Certificate(ca).ca) throw new Error('CA required');
  } catch { throw new Error('PostgreSQL CA file must contain a readable CA certificate.'); }
  return {
    host: url.searchParams.get('hostaddr')!, port: url.port ? Number(url.port) : 5432,
    user: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
    database: url.pathname.slice(1),
    ssl: { ca, servername: 'jimbrownhome1', rejectUnauthorized: true },
  };
}
