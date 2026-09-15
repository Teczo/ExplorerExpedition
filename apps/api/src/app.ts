import express, { type Express } from 'express';
import { ENGINE_VERSION } from '@explorer/engine';
import type { OrganisationId } from '@explorer/shared-types';

import { readAuthConfig, type AuthConfig } from './config/auth-config.ts';
import { AuthService, authErrorHandler, createAuthRouter } from './auth/index.ts';
import { globalRepository, tenantRepository, type Queryable } from './db/index.ts';
import { AccountRepository } from './repositories/account-repository.ts';
import { DeviceRepository } from './repositories/device-repository.ts';

/** What `createApp` can be given. */
export interface AppOptions {
  /**
   * The database.
   *
   * Absent in the scaffold, because no driver has been added to the
   * repository yet: opening a connection is EXPD-016. Without it the app
   * serves the health check and nothing else, which is what deploy targets
   * need and all they need.
   *
   * With it, the auth routes are mounted. `pg.Pool` satisfies `Queryable` as
   * it is, so EXPD-016 has nothing to write here but the pool.
   */
  readonly db?: Queryable;
  /** Read from the environment when absent. */
  readonly authConfig?: AuthConfig;
}

/**
 * Builds the Express application.
 *
 * Most routes are added in later tickets. EXPD-016 owns the REST API
 * skeleton; this mounts the health check and, when there is a database, the
 * sign-in endpoints from EXPD-004.
 */
export function createApp(options: AppOptions = {}): Express {
  const app = express();

  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      engineVersion: ENGINE_VERSION,
    });
  });

  if (options.db !== undefined) {
    app.use('/auth', createAuthRouter(buildAuthService(options.db, options.authConfig)));
    app.use(authErrorHandler());
  }

  return app;
}

/**
 * Wires the auth service to the repository layer.
 *
 * Exported so that a test, a script, or the MCP server (EXPD-074) can build
 * the same service without building an Express app around it.
 */
export function buildAuthService(db: Queryable, config?: AuthConfig): AuthService {
  return new AuthService({
    config: config ?? readAuthConfig(),
    accounts: new AccountRepository(db, globalRepository(db)),
    devicesFor: (organisationId: OrganisationId) =>
      new DeviceRepository(tenantRepository(db, { organisationId })),
  });
}
