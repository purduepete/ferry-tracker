import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';

dotenv.config({ path: fileURLToPath(new URL('../../.env.local', import.meta.url)) });
dotenv.config({ path: fileURLToPath(new URL('../../.env', import.meta.url)) });

export interface AppConfig {
  port: number;
  dataSource: 'live' | 'fixture';
  apiAccessCode?: string;
  rawInspector: boolean;
  fixtureNow?: string;
}

export function getConfig(): AppConfig {
  const dataSource = process.env.DATA_SOURCE === 'live' ? 'live' : 'fixture';
  return {
    port: Number(process.env.PORT ?? 8787),
    dataSource,
    apiAccessCode: process.env.WSDOT_API_ACCESS_CODE,
    rawInspector: process.env.ENABLE_RAW_INSPECTOR !== 'false',
    fixtureNow: dataSource === 'fixture' ? process.env.FIXTURE_NOW : undefined,
  };
}