import { Router } from 'express';
import { badRequest, HttpError } from '../lib/errors.js';
import { EMAIL_PATTERN } from '../lib/validate.js';

export function loginRoute({ userStore, tokens, limiter, config }) {
  const router = Router();

  router.post('/login', async (req, res) => {
    const { email, password } = req.body ?? {};
    if (typeof email !== 'string' || typeof password !== 'string') throw badRequest('email and password are required');
    if (email.length > 254 || !EMAIL_PATTERN.test(email.trim())) throw badRequest('email is not valid');
    if (password.length < 1 || password.length > 200) throw badRequest('password must be 1 to 200 characters');

    const key = `${email.trim().toLowerCase()}|${req.ip}`;
    const wait = limiter.retryAfterSeconds(key);
    if (wait > 0) {
      res.set('Retry-After', String(wait));
      throw new HttpError(429, 'TOO_MANY_ATTEMPTS', 'Too many failed sign-in attempts. Try again later.');
    }

    const user = await userStore.authenticate(email, password);
    if (!user) {
      limiter.recordFailure(key);
      throw new HttpError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
    }
    limiter.reset(key);
    res.json({ token: tokens.sign(user), token_type: 'Bearer', expires_in: config.tokenTtl, user });
  });

  return router;
}

export function meRoute() {
  const router = Router();
  router.get('/me', (req, res) => res.json({ user: req.user }));
  return router;
}
