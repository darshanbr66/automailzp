// Cumulative list of attorney names this user has successfully emailed in this
// browser session, for copying to the clipboard. Kept per browser tab in
// sessionStorage, so each team member has their own list. No React here, so the
// logic can be unit-tested with Node.

export const STORAGE_KEY = 'zp-sent-attorney-names';

const normalize = (name) => String(name ?? '').replace(/\s+/g, ' ').trim();
const keyOf = (name) => normalize(name).toLowerCase();

/** The label used for an attorney: the name, or the email address when the row has no name. */
export function labelFor({ attorneyName, recipientEmail } = {}) {
  return normalize(attorneyName) || normalize(recipientEmail);
}

/** Return a new list with `name` appended, unless it is empty or already present (case/space-insensitive). */
export function addName(list, name) {
  const clean = normalize(name);
  if (!clean || list.some((n) => keyOf(n) === keyOf(clean))) return list;
  return [...list, clean];
}

/** Clipboard contents: one name per line. */
export function clipboardText(list) {
  return list.join('\n');
}

const countText = (n) => `${n} email${n === 1 ? '' : 's'} sent`;

/** "2 emails sent – Attorney A, Attorney B copied to clipboard. Please check." */
export function copiedMessage(list) {
  return `${countText(list.length)} – ${list.join(', ')} copied to clipboard. Please check.`;
}

/** Shown when the browser does not allow automatic copying. */
export function manualCopyMessage(list) {
  return `${countText(list.length)} – ${list.join(', ')}. The names could not be copied automatically: please click "Copy names" or copy them below.`;
}

/**
 * Small store around sessionStorage. Every read and write is guarded: in a
 * private window or with storage blocked, the list simply lives in memory for
 * this page.
 * @param {Storage|null} storage
 */
export function createSentNamesStore(storage) {
  let memory = [];
  const read = () => {
    try {
      const raw = storage?.getItem(STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      if (Array.isArray(parsed)) memory = parsed.filter((x) => typeof x === 'string' && normalize(x));
    } catch {
      /* unavailable or damaged: keep the in-memory copy */
    }
    return memory;
  };
  const write = (list) => {
    memory = list;
    try {
      storage?.setItem(STORAGE_KEY, JSON.stringify(list));
    } catch {
      /* unavailable: in memory only */
    }
  };
  return {
    list: () => [...read()],
    /** Add a name and return the updated list. */
    add(name) {
      const next = addName(read(), name);
      write(next);
      return [...next];
    },
    clear() {
      memory = [];
      try {
        storage?.removeItem(STORAGE_KEY);
      } catch {
        /* ignore */
      }
    },
  };
}

/**
 * Copy text to the clipboard. Returns true on success, false if the browser
 * refused (no permission, page not focused, insecure context, ...).
 */
export async function copyToClipboard(text, { clipboard = globalThis.navigator?.clipboard, doc = globalThis.document } = {}) {
  try {
    if (clipboard?.writeText) {
      await clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy method */
  }
  try {
    if (!doc?.body || typeof doc.execCommand !== 'function') return false;
    const area = doc.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    doc.body.appendChild(area);
    area.select();
    const ok = doc.execCommand('copy');
    doc.body.removeChild(area);
    return Boolean(ok);
  } catch {
    return false;
  }
}

/** Run clipboard copies one after another, so a slower copy can never overwrite a newer list. */
export function createCopyQueue(copy = copyToClipboard) {
  let tail = Promise.resolve();
  return (text) => {
    const result = tail.then(() => copy(text));
    tail = result.catch(() => {});
    return result;
  };
}

function browserSessionStorage() {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null; // access itself can throw when storage is blocked
  }
}

/** This browser tab's list (one per team member's browser). */
export const sessionSentNames = createSentNamesStore(browserSessionStorage());
export const queuedCopy = createCopyQueue();
