// Timestamps are stored in UTC and shown in the viewer's own time zone.

export const userTimeZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};

/** "17 Nov 2026, 14:05:09" in the viewer's time zone. */
export function formatLocal(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.valueOf())) return '';
  return d.toLocaleString(undefined, { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/**
 * When something happened: the UTC timestamp in local time, or (older rows
 * written before UTC timestamps existed) the original server-time text.
 */
export function whenOf(entry) {
  if (entry?.sentAtUtc) return formatLocal(entry.sentAtUtc);
  return entry?.sentAt ? `${entry.sentAt} (server time)` : '';
}
