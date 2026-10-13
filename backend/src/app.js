import express, { Router } from 'express';
import { authenticate } from './auth/middleware.js';
import { createLoginLimiter } from './auth/login-limiter.js';
import { errorHandler, notFound } from './lib/errors.js';
import { adminRoutes } from './routes/admin.js';
import { alertRoutes } from './routes/alerts.js';
import { loginRoute, meRoute } from './routes/auth.js';
import { costRoutes } from './routes/costs.js';
import { fleetRoutes } from './routes/fleet.js';
import { triageRoutes } from './routes/triage.js';
import { staticUi } from './static-ui.js';

export function createApp({ store, userStore, tokens, config, logger = console, limiter, alerts, triage }) {
  const app = express();
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
    next();
  });
  app.use(express.json({ limit: '10kb' }));

  // Liveness only; no data. The fleet health view is GET /api/health (authenticated).
  app.get('/healthz', (req, res) => res.json({ status: 'ok' }));

  const loginLimiter = limiter ?? createLoginLimiter({ maxFailures: config.loginMaxFailures, windowMs: config.loginWindowMs });
  const api = Router();
  api.use('/auth', loginRoute({ userStore, tokens, limiter: loginLimiter, config }));

  // Everything below requires a valid token.
  api.use(authenticate(tokens));
  api.use('/auth', meRoute());
  api.use(fleetRoutes({ store }));
  api.use(costRoutes({ store }));
  if (alerts) api.use(alertRoutes({ alerts }));
  if (triage) api.use(triageRoutes({ triage }));
  api.use(adminRoutes({ store }));
  api.use((req, res, next) => next(notFound('No such endpoint')));

  app.use('/api', api);

  const ui = config.staticDir ? staticUi(config.staticDir) : null;
  if (ui) app.use(...ui);

  app.use((req, res, next) => next(notFound('No such endpoint')));
  app.use(errorHandler(logger));
  return app;
}
