// The team member using this browser session (self-declared: the team shares one
// login). Chosen from the list the server provides, kept in sessionStorage, and
// sent with each request so the server can record it with actions. It is never
// inferred from IP address, browser or device.
const KEY = 'zp-operator';
let memory = null;
const listeners = new Set();

export function getOperator() {
  try {
    return sessionStorage.getItem(KEY) || memory;
  } catch {
    return memory;
  }
}

export function setOperator(name) {
  memory = name || null;
  try {
    if (name) sessionStorage.setItem(KEY, name);
    else sessionStorage.removeItem(KEY);
  } catch {
    /* in memory only */
  }
  for (const fn of listeners) fn(memory);
}

/**
 * The configured team member matching `name` (case/space-insensitive, as the
 * server matches it), or null. A name the server would reject counts as "no
 * operator chosen", so the prompt asks again instead of every action failing.
 */
export function knownOperator(name, teamMembers) {
  const clean = String(name ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!clean || !Array.isArray(teamMembers)) return null;
  return teamMembers.find((m) => String(m).toLowerCase() === clean) || null;
}

export function onOperatorChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
