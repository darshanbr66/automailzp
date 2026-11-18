// Audit context for the team activity log, collected ON THE BACKEND from the
// request itself. Nothing here proves who a person is:
//  - the operator name is self-declared (the team shares one login),
//  - the IP is what the proxy chain reports,
//  - device details come from the browser's User-Agent header.
import { AppError } from './utils.js';
import { parseUserAgent } from './useragent.js';

export const OPERATOR_HEADER = 'x-operator';
const MAX_OPERATOR = 60;

/** Parse the configured team member names (TEAM_MEMBERS, comma-separated). */
export function parseTeamMembers(value) {
  const names = String(value || '')
    .split(',')
    .map((s) => s.replace(/\s+/g, ' ').trim().slice(0, MAX_OPERATOR))
    .filter(Boolean);
  const unique = [...new Map(names.map((n) => [n.toLowerCase(), n])).values()].slice(0, 20);
  return unique.length ? unique : ['Team Member 1', 'Team Member 2'];
}

/**
 * The operator the user selected in this browser session (sent in a header).
 * Accepted only if it is one of the configured names. Returns null if absent/unknown.
 */
export function operatorFromRequest(req, teamMembers) {
  let raw = req.headers[OPERATOR_HEADER];
  if (typeof raw !== 'string' || !raw) return null;
  try {
    raw = decodeURIComponent(raw);
  } catch {
    return null;
  }
  const name = raw.replace(/\s+/g, ' ').trim();
  return teamMembers.find((m) => m.toLowerCase() === name.toLowerCase()) || null;
}

export function requireOperator(req, teamMembers) {
  const op = operatorFromRequest(req, teamMembers);
  if (!op) {
    throw new AppError(400, 'OPERATOR_REQUIRED', 'Please choose who is using this browser (at the top of the page) before continuing. This is recorded with your actions.');
  }
  return op;
}

const cleanIp = (ip) => String(ip || '').trim().replace(/^::ffff:/, '').slice(0, 64) || null;

/**
 * Client IP as reported by the proxy chain. The chain is X-Forwarded-For plus
 * the address that connected to this server; `hops` is how many trusted proxies
 * sit in front (production: Vercel + Render's load balancer = 2). With hops=0 the
 * connecting address is used. Behind Vercel the reported value is the visitor's
 * IP as Vercel saw it; a request sent straight to the Render URL could fake it,
 * which is why it is stored as "reported", never as proof of identity.
 */
export function reportedClientIp(req, hops = 0) {
  const xff = String(req.headers['x-forwarded-for'] || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const chain = [...xff, req.socket?.remoteAddress || ''];
  const idx = Math.max(0, chain.length - 1 - hops);
  return cleanIp(chain[idx]);
}

/**
 * Approximate location, only from Vercel's own edge geolocation headers if they
 * reach the backend. Otherwise "unavailable": no guessing and no paid lookup.
 */
export function approximateLocation(req) {
  const h = (name) => {
    const v = req.headers[name];
    if (typeof v !== 'string' || !v.trim()) return '';
    try {
      return decodeURIComponent(v).slice(0, 80);
    } catch {
      return '';
    }
  };
  const city = h('x-vercel-ip-city');
  const region = h('x-vercel-ip-country-region');
  const country = h('x-vercel-ip-country');
  if (!city && !region && !country) return { available: false, city: null, region: null, country: null, source: null };
  return { available: true, city: city || null, region: region || null, country: country || null, source: 'Vercel edge geolocation headers (approximate, not verified)' };
}

/**
 * Everything recorded about the person performing an action.
 * @param {import('express').Request} req
 * @param {{ teamMembers: string[], clientIpHops: number }} opts
 */
export function auditContext(req, { teamMembers, clientIpHops }) {
  const ua = parseUserAgent(req.headers['user-agent']);
  return {
    operator: operatorFromRequest(req, teamMembers),
    operatorIdType: 'self-declared',
    ip: reportedClientIp(req, clientIpHops),
    ipNote: 'Reported by the proxy chain; not proof of identity.',
    location: approximateLocation(req),
    os: ua.os,
    osVersion: ua.osVersion,
    browser: ua.browser,
    browserVersion: ua.browserVersion,
    deviceType: ua.deviceType,
  };
}
