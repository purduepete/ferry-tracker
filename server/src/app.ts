import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Request, type Response } from 'express';
import { type ApiEnvelope, redactSecrets } from '@ferry-tracker/shared';
import { ZodError } from 'zod';
import type { CaptureService } from './capture/captureService.js';
import type { AppConfig } from './config.js';
import { FerryDataService } from './ferryDataService.js';
import type { SailingHistory } from './history/sailingHistory.js';
import { WsdotClient } from './wsdotClient.js';

function terminalId(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function createApp(
  config: AppConfig,
  now: () => number = Date.now,
  capture?: CaptureService,
  history?: SailingHistory,
) {
  const app = express();
  const service = new FerryDataService(new WsdotClient(config), now, history);
  service.warmCameras();

  const send = <T>(response: Response, result: { data: T; raw: unknown }) => {
    const envelope: ApiEnvelope<T> = {
      data: result.data,
      fetchedAt: new Date().toISOString(),
      source: config.dataSource,
      raw: config.rawInspector ? result.raw : null,
    };
    response.json(envelope);
  };

  app.get('/api/health', (_request, response) => response.json({ status: 'ok', source: config.dataSource }));
  app.get('/api/capture/status', (_request, response, next) => {
    if (!capture || !config.capture.statusEnabled) {
      response.status(404).json({ error: 'Capture status is not available.' });
      return;
    }
    try { response.json(capture.status()); } catch (error) { next(error); }
  });
  app.get('/api/terminals', async (_request, response, next) => {
    try { send(response, await service.terminals()); } catch (error) { next(error); }
  });
  app.get('/api/vessels', async (_request, response, next) => {
    try { send(response, await service.vessels()); } catch (error) { next(error); }
  });
  app.get('/api/terminal-mates', async (_request, response, next) => {
    try { send(response, await service.terminalMates()); } catch (error) { next(error); }
  });
  app.get('/api/sailing-spaces', async (request, response, next) => {
    const departingId = terminalId(request.query.departingTerminalId);
    const arrivingId = terminalId(request.query.arrivingTerminalId);
    if (!departingId || !arrivingId || departingId === arrivingId) {
      response.status(400).json({ error: 'Valid, different departingTerminalId and arrivingTerminalId values are required.' });
      return;
    }
    try { send(response, await service.sailingSpaces(departingId, arrivingId)); } catch (error) { next(error); }
  });
  app.get('/api/schedule', async (request, response, next) => {
    const departingId = terminalId(request.query.departingTerminalId);
    const arrivingId = terminalId(request.query.arrivingTerminalId);
    if (!departingId || !arrivingId || departingId === arrivingId) {
      response.status(400).json({ error: 'Valid, different departingTerminalId and arrivingTerminalId values are required.' });
      return;
    }
    const onlyRemaining = request.query.onlyRemaining === 'true';
    try { send(response, await service.schedule(departingId, arrivingId, onlyRemaining)); } catch (error) { next(error); }
  });

  app.get('/api/crossings', (_request, response, next) => {
    if (!history) {
      response.status(404).json({ error: 'Recorded crossings are not available.' });
      return;
    }
    try { send(response, { data: history.crossings(), raw: null }); } catch (error) { next(error); }
  });

  app.get('/api/history/dates', (request, response, next) => {
    const departingId = terminalId(request.query.departingTerminalId);
    const arrivingId = terminalId(request.query.arrivingTerminalId);
    if (!departingId || !arrivingId || departingId === arrivingId) {
      response.status(400).json({ error: 'Valid, different departingTerminalId and arrivingTerminalId values are required.' });
      return;
    }
    if (!history) {
      response.status(404).json({ error: 'Recorded sailings are not available.' });
      return;
    }
    try { send(response, { data: history.serviceDates(departingId, arrivingId), raw: null }); } catch (error) { next(error); }
  });
  app.get('/api/history/sailings', (request, response, next) => {
    const departingId = terminalId(request.query.departingTerminalId);
    const arrivingId = terminalId(request.query.arrivingTerminalId);
    const serviceDate = typeof request.query.serviceDate === 'string' ? request.query.serviceDate : '';
    if (!departingId || !arrivingId || departingId === arrivingId || !/^\d{4}-\d{2}-\d{2}$/.test(serviceDate)) {
      response.status(400).json({ error: 'Valid, different terminal ids and a YYYY-MM-DD serviceDate are required.' });
      return;
    }
    if (!history) {
      response.status(404).json({ error: 'Recorded sailings are not available.' });
      return;
    }
    try { send(response, { data: history.daySailings(departingId, arrivingId, serviceDate), raw: null }); } catch (error) { next(error); }
  });

  const frontendDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../frontend/dist');
  const assetsPrefix = `${path.sep}assets${path.sep}`;
  app.use(express.static(frontendDist, {
    setHeaders: (response, filePath) => {
      // Vite fingerprints /assets, so only those are safe to pin; index.html has to revalidate or a
      // stale shell keeps requesting asset hashes that no longer exist.
      if (filePath.endsWith('index.html')) response.setHeader('Cache-Control', 'no-cache');
      else if (filePath.includes(assetsPrefix)) response.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      else response.setHeader('Cache-Control', 'public, max-age=3600');
    },
  }));
  app.get('/{*path}', (request, response, next) => {
    if (request.path.startsWith('/api/')) return next();
    response.setHeader('Cache-Control', 'no-cache');
    response.sendFile(path.join(frontendDist, 'index.html'));
  });

  app.use((error: unknown, _request: Request, response: Response, _next: unknown) => {
    const message = error instanceof ZodError
      ? `WSDOT returned an unexpected data shape (${error.issues.length} validation ${error.issues.length === 1 ? 'issue' : 'issues'}).`
      : error instanceof Error ? error.message : 'Unknown server error.';
    const safeMessage = redactSecrets(message, config.apiAccessCode);
    response.status(502).json({ error: safeMessage });
  });

  return app;
}