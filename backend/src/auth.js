// Shared team login: password hashing, file-based sessions and login rate limiting.
// Uses only Node's built-in crypto (scrypt, HMAC) and the filesystem; no database.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { atomicWriteFile, safeEqual } from './utils.js';

const scrypt = promisify(crypto.scrypt);

// ---------------------------------------------------------------------------
// Password hashing (scrypt). Stored format, safe in .env files and Render env vars
// (no "$" characters, so nothing is ever treated as variable expansion):
//   scrypt:<N>:<r>:<p>:<salt base64url>:<hash base64url>
// ---------------------------------------------------------------------------
const DEFAULT_PARAMS = { N: 32768, r: 8, p: 1 };
const KEY_LEN = 64;
const HASH_RE = /^scrypt:(\d+):(\d+):(\d+):([A-Za-z0-9_-]{16,}):([A-Za-z0-9_-]{40,})$/;
const scryptOptions = ({ N, r, p }) => ({ N, r, p, maxmem: 256 * N * r });

export const MIN_PASSWORD_LENGTH = 12;

export async function hashPassword(password, params = DEFAULT_PARAMS) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`The shared password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password.normalize('NFKC'), salt, KEY_LEN, scryptOptions(params));
  return `scrypt:${params.N}:${params.r}:${params.p}:${salt.toString('base64url')}:${key.toString('base64url')}`;
}

export function isValidPasswordHash(stored) {
  const m = HASH_RE.exec(String(stored ?? ''));
  if (!m) return false;
  const [N, r, p] = [Number(m[1]), Number(m[2]), Number(m[3])];
  // N must be a power of two; keep parameters within sane bounds.
  return N >= 16384 && N <= 1048576 && (N & (N - 1)) === 0 && r >= 8 && r <= 32 && p >= 1 && p <= 16;
}

export async function verifyPassword(password, stored) {
  const m = HASH_RE.exec(String(stored ?? ''));
  if (!m || !isValidPasswordHash(stored) || typeof password !== 'string') return false;
  const params = { N: Number(m[1]), r: Number(m[2]), p: Number(m[3]) };
  const expected = Buffer.from(m[5], 'base64url');
  const key = await scrypt(password.normalize('NFKC'), Buffer.from(m[4], 'base64url'), expected.length, scryptOptions(params));
  return crypto.timingSafeEqual(key, expected);
}

// ---------------------------------------------------------------------------
// Sessions stored as small JSON files (one per session) on the persistent disk.
// The cookie carries a random 256-bit ID. On disk the file is named by
// HMAC(SESSION_SECRET, id), so the session files alone cannot be used to forge
// or hijack a cookie. Sessions expire after an idle period and an absolute
// maximum age, and are swept periodically.
// ---------------------------------------------------------------------------
const SESSION_ID_RE = /^[A-Za-z0-9_-]{43}$/;
const TOUCH_INTERVAL_MS = 60 * 1000;

export class FileSessionStore {
  /**
   * @param {string} dir
   * @param {{ secret: string, idleMs: number, maxAgeMs: number, now?: () => number }} options
   */
  constructor(dir, { secret, idleMs, maxAgeMs, now = Date.now }) {
    this.dir = dir;
    this.secret = secret;
    this.idleMs = idleMs;
    this.maxAgeMs = maxAgeMs;
    this.now = now;
    this.ready = fs.mkdir(dir, { recursive: true, mode: 0o700 });
  }

  #file(id) {
    const name = crypto.createHmac('sha256', this.secret).update(id).digest('hex');
    return path.join(this.dir, `${name}.json`);
  }

  #expired(s) {
    const t = this.now();
    return !s || typeof s.createdAt !== 'number' || typeof s.lastSeen !== 'number' || t - s.createdAt > this.maxAgeMs || t - s.lastSeen > this.idleMs;
  }

  async create(username) {
    await this.ready;
    const id = crypto.randomBytes(32).toString('base64url');
    const t = this.now();
    const session = { username, createdAt: t, lastSeen: t, csrfToken: crypto.randomBytes(32).toString('base64url') };
    await atomicWriteFile(this.#file(id), JSON.stringify(session));
    return { id, session };
  }

  /** Returns the session (and refreshes its idle timer) or null when missing/expired/invalid. */
  async get(id) {
    if (typeof id !== 'string' || !SESSION_ID_RE.test(id)) return null;
    await this.ready;
    const file = this.#file(id);
    let session;
    try {
      session = JSON.parse(await fs.readFile(file, 'utf8'));
    } catch {
      return null;
    }
    if (this.#expired(session)) {
      await fs.rm(file, { force: true }).catch(() => {});
      return null;
    }
    const t = this.now();
    if (t - session.lastSeen > TOUCH_INTERVAL_MS) {
      session.lastSeen = t;
      await atomicWriteFile(file, JSON.stringify(session)).catch(() => {});
    }
    return session;
  }

  /** Milliseconds until the session's absolute expiry. */
  remainingMs(session) {
    return Math.max(0, session.createdAt + this.maxAgeMs - this.now());
  }

  async destroy(id) {
    if (typeof id !== 'string' || !SESSION_ID_RE.test(id)) return;
    await fs.rm(this.#file(id), { force: true }).catch(() => {});
  }

  /** Delete expired session files. Returns the number removed. */
  async sweep() {
    await this.ready;
    let removed = 0;
    for (const name of await fs.readdir(this.dir).catch(() => [])) {
      if (!name.endsWith('.json')) continue;
      const file = path.join(this.dir, name);
      try {
        if (this.#expired(JSON.parse(await fs.readFile(file, 'utf8')))) {
          await fs.rm(file, { force: true });
          removed += 1;
        }
      } catch {
        await fs.rm(file, { force: true }).catch(() => {}); // unreadable or partial: discard
        removed += 1;
      }
    }
    return removed;
  }
}

// ---------------------------------------------------------------------------
// Login rate limiting (in memory; one service instance).
//   - per client IP: 5 failed attempts per 15 minutes, then locked for 15 minutes
//   - all clients:   50 failed attempts per 15 minutes, then logins pause for 15 minutes
// ---------------------------------------------------------------------------
export class LoginLimiter {
  constructor({ perIp = 5, global = 50, windowMs = 15 * 60 * 1000, lockMs = 15 * 60 * 1000, now = Date.now } = {}) {
    Object.assign(this, { perIp, global, windowMs, lockMs, now });
    this.byIp = new Map();
    this.all = { count: 0, start: 0, lockedUntil: 0 };
  }

  #bucket(b) {
    const t = this.now();
    if (t - b.start > this.windowMs && t >= b.lockedUntil) Object.assign(b, { count: 0, start: t, lockedUntil: 0 });
    return b;
  }

  /** Seconds the caller must wait, or 0 when an attempt is allowed. */
  retryAfter(ip) {
    const t = this.now();
    const g = this.#bucket(this.all);
    const b = this.byIp.has(ip) ? this.#bucket(this.byIp.get(ip)) : null;
    const until = Math.max(g.lockedUntil, b?.lockedUntil || 0);
    return until > t ? Math.ceil((until - t) / 1000) : 0;
  }

  fail(ip) {
    const t = this.now();
    if (!this.byIp.has(ip)) this.byIp.set(ip, { count: 0, start: t, lockedUntil: 0 });
    const b = this.#bucket(this.byIp.get(ip));
    const g = this.#bucket(this.all);
    b.count += 1;
    g.count += 1;
    if (b.count >= this.perIp) b.lockedUntil = t + this.lockMs;
    if (g.count >= this.global) g.lockedUntil = t + this.lockMs;
    if (this.byIp.size > 10000) this.prune();
  }

  succeed(ip) {
    this.byIp.delete(ip);
  }

  prune() {
    const t = this.now();
    for (const [ip, b] of this.byIp) if (t - b.start > this.windowMs && t >= b.lockedUntil) this.byIp.delete(ip);
  }
}

// ---------------------------------------------------------------------------
// Cookies
// ---------------------------------------------------------------------------
export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const name = part.slice(0, i).trim();
    if (!(name in out)) out[name] = part.slice(i + 1).trim();
  }
  return out;
}

/**
 * Cookie settings. In production the cookie is "__Host-" prefixed (Secure, Path=/,
 * no Domain: only ever sent to api.zodiacpatent.com itself), HttpOnly, and
 * SameSite=Lax. app.zodiacpatent.com and api.zodiacpatent.com are the same
 * *site*, so the browser sends it on the frontend's credentialed fetches, while
 * other sites' requests never carry it.
 */
export function sessionCookie(isProduction) {
  return {
    name: isProduction ? '__Host-zp_session' : 'zp_session',
    options: { httpOnly: true, secure: isProduction, sameSite: 'lax', path: '/' },
  };
}

export { safeEqual };
