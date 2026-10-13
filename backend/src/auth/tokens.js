import jwt from 'jsonwebtoken';

const ALGORITHM = 'HS256';

export function createTokenService({ secret, ttl }) {
  return {
    sign(user) {
      return jwt.sign({ email: user.email, role: user.role }, secret, { algorithm: ALGORITHM, expiresIn: ttl, subject: user.email });
    },
    // The algorithm is pinned so a token cannot pick its own (e.g. "none").
    verify(token) {
      return jwt.verify(token, secret, { algorithms: [ALGORITHM] });
    },
  };
}
