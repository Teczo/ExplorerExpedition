import express, { type Express } from 'express';
import { ENGINE_VERSION } from '@explorer/engine';

/**
 * Builds the Express application.
 *
 * Routes are added in later tickets. EXPD-016 owns the REST API skeleton, so
 * this scaffold only mounts the health check that deploy targets need.
 */
export function createApp(): Express {
  const app = express();

  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      engineVersion: ENGINE_VERSION,
    });
  });

  return app;
}
