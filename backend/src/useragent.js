// Small, dependency-free User-Agent parser for the team activity log.
// It only reads the standard User-Agent header the browser already sends: no
// fingerprinting. Results are approximate (browsers can change or reduce this
// string), so they describe a device, they never identify a person.

const BROWSERS = [
  // Order matters: Edge/Opera/Samsung contain "Chrome", Chrome contains "Safari".
  ['Edge', /Edg(?:e|A|iOS)?\/([\d.]+)/],
  ['Opera', /(?:OPR|Opera)\/([\d.]+)/],
  ['Samsung Internet', /SamsungBrowser\/([\d.]+)/],
  ['Firefox', /(?:Firefox|FxiOS)\/([\d.]+)/],
  ['Chrome', /(?:Chrome|CriOS)\/([\d.]+)/],
  ['Safari', /Version\/([\d.]+).*Safari\//],
];

function os(ua) {
  let m;
  if ((m = ua.match(/Windows NT ([\d.]+)/))) {
    const v = { '10.0': '10 or 11', '6.3': '8.1', '6.2': '8', '6.1': '7' }[m[1]];
    return { name: 'Windows', version: v || m[1] };
  }
  if ((m = ua.match(/(?:iPhone|iPad|iPod).*? OS ([\d_]+)/))) return { name: 'iOS', version: m[1].replace(/_/g, '.') };
  if ((m = ua.match(/Android ([\d.]+)/))) return { name: 'Android', version: m[1] };
  if (/CrOS/.test(ua)) return { name: 'ChromeOS', version: '' };
  if ((m = ua.match(/Mac OS X ([\d_.]+)/))) return { name: 'macOS', version: m[1].replace(/_/g, '.') };
  if (/Linux/.test(ua)) return { name: 'Linux', version: '' };
  return { name: 'Unknown', version: '' };
}

function deviceType(ua, osName) {
  if (/iPad|Tablet|PlayBook|Silk/i.test(ua) || (osName === 'Android' && !/Mobile/i.test(ua))) return 'tablet';
  if (/Mobi|iPhone|iPod|Windows Phone/i.test(ua)) return 'mobile';
  if (['Windows', 'macOS', 'Linux', 'ChromeOS'].includes(osName)) return 'desktop or laptop'; // not distinguishable from the User-Agent
  return 'unknown';
}

/** @returns {{ os: string, osVersion: string, browser: string, browserVersion: string, deviceType: string }} */
export function parseUserAgent(header) {
  const ua = String(header || '').slice(0, 512);
  if (!ua) return { os: 'Unknown', osVersion: '', browser: 'Unknown', browserVersion: '', deviceType: 'unknown' };
  const o = os(ua);
  let browser = 'Unknown';
  let browserVersion = '';
  for (const [name, re] of BROWSERS) {
    const m = ua.match(re);
    if (m) {
      browser = name;
      browserVersion = m[1];
      break;
    }
  }
  return { os: o.name, osVersion: o.version, browser, browserVersion, deviceType: deviceType(ua, o.name) };
}
