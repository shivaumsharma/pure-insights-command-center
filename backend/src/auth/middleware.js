import { forbidden, unauthenticated } from '../lib/errors.js';

export function authenticate(tokens) {
  return (req, res, next) => {
    const header = req.get('authorization') ?? '';
    const match = /^Bearer ([A-Za-z0-9._-]+)$/.exec(header);
    if (!match) return next(unauthenticated());
    try {
      const claims = tokens.verify(match[1]);
      req.user = { email: claims.email, role: claims.role };
      return next();
    } catch {
      // Expired, malformed, wrong signature and wrong algorithm all look the same to the caller.
      return next(unauthenticated('Invalid or expired token'));
    }
  };
}

export function requireRole(...roles) {
  return (req, res, next) => (roles.includes(req.user.role) ? next() : next(forbidden()));
}
