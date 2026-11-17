import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * An error that is safe to show to the user. `status` is the HTTP status and
 * `code` a stable machine-readable identifier used by the frontend.
 */
export class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

/** Serializes async operations: each run() waits for the previous one to finish. */
export class Mutex {
  #tail = Promise.resolve();

  run(fn) {
    const result = this.#tail.then(() => fn());
    // Keep the chain alive even if fn rejects.
    this.#tail = result.catch(() => {});
    return result;
  }
}

/**
 * Write a file atomically: write to a temporary file in the same directory,
 * then rename it over the target. A crash mid-write never leaves a half file.
 */
export async function atomicWriteFile(filePath, data) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  try {
    await fs.writeFile(tmp, data, { mode: 0o600 });
    await fs.rename(tmp, filePath);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/** Read a file, returning null if it does not exist. */
export async function readFileIfExists(filePath, encoding) {
  try {
    return await fs.readFile(filePath, encoding);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/** Read and parse a JSON file. Returns null if missing; throws on invalid JSON. */
export async function readJsonFile(filePath) {
  const text = await readFileIfExists(filePath, 'utf8');
  if (text === null) return null;
  return JSON.parse(text);
}

export function writeJsonFile(filePath, value) {
  return atomicWriteFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

/** Local date-time as "YYYY-MM-DD HH:mm:ss" (sortable and readable in Excel). */
export function formatDateTime(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
}

/** Normalize a record identifier for duplicate comparison. */
export function normalizeId(value) {
  return String(value ?? '').trim().toLowerCase();
}

export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Constant-time string comparison. */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}
