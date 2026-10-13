import crypto from 'node:crypto';
import fs from 'node:fs';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);
const KEY_LENGTH = 64;
export const ROLES = ['admin', 'owner', 'viewer'];

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, KEY_LENGTH);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

export async function verifyPassword(password, stored) {
  const [scheme, saltHex, keyHex] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltHex || !keyHex) return false;
  const expected = Buffer.from(keyHex, 'hex');
  const actual = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

// Plaintext demo passwords are hashed once at startup and never kept or returned afterwards.
export async function createUserStore(users) {
  const byEmail = new Map();
  for (const u of users) {
    if (!ROLES.includes(u.role)) throw new Error(`Unknown role '${u.role}' for ${u.email}`);
    const email = u.email.trim().toLowerCase();
    if (byEmail.has(email)) throw new Error(`Duplicate user ${email}`);
    byEmail.set(email, { email, name: u.name, role: u.role, passwordHash: await hashPassword(u.password) });
  }
  // Verified against when the email is unknown, so unknown-user and wrong-password take similar time.
  const decoyHash = await hashPassword(crypto.randomBytes(16).toString('hex'));

  return {
    async authenticate(email, password) {
      const user = byEmail.get(String(email).trim().toLowerCase());
      const ok = await verifyPassword(password, user ? user.passwordHash : decoyHash);
      return user && ok ? { email: user.email, name: user.name, role: user.role } : null;
    },
    count: () => byEmail.size,
  };
}

export function readUsersFile(file) {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(parsed.users)) throw new Error(`${file} must contain a "users" array`);
  return parsed.users;
}
