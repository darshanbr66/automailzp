// File storage: the original behaviour (Excel history + JSON files, uploaded
// workbook in memory only, in-process locks). Used when MONGODB_URI is not set,
// so existing installations work exactly as before.
import path from 'node:path';
import { AppError, Mutex, isPlainObject, normalizeId, readJsonFile, writeJsonFile } from '../utils.js';
import { HistoryStore } from '../history.js';
import { TemplateStore } from '../template.js';
import { sanitizeMapping } from '../excel.js';

export function createFileStorage(dataDir) {
  const history = new HistoryStore(dataDir);
  const templates = new TemplateStore(dataDir);
  const settingsPath = path.join(dataDir, 'settings.json');
  const settingsMutex = new Mutex();
  const sending = new Set(); // record keys being sent in THIS process

  return {
    kind: 'file',
    features: { persistentWorkbook: false, manualMarking: false, corrections: false, activity: false, operatorRequired: false, blocksUncertain: false },
    historyLabel: 'backend/data/sent-emails.xlsx',

    history: {
      entriesInOrder: () => history.entriesInOrder(),
      readAll: () => history.readAll(),
      append: (entry) => history.append(entry),
    },

    templates: {
      load: () => templates.load(),
      save: (input) => templates.save(input),
    },

    mappings: {
      async load() {
        try {
          const s = await readJsonFile(settingsPath);
          return isPlainObject(s?.mapping) ? sanitizeMapping(s.mapping) : null;
        } catch {
          return null;
        }
      },
      save: (mapping) =>
        settingsMutex.run(async () => {
          const settings = (await readJsonFile(settingsPath).catch(() => null)) || {};
          await writeJsonFile(settingsPath, { ...(isPlainObject(settings) ? settings : {}), mapping });
        }),
    },

    // The workbook lives only in the app's memory in this mode.
    workbooks: {
      currentVersion: async () => undefined, // "unknown": the in-memory copy is authoritative
      loadCurrent: async () => null,
      save: async () => {},
      clear: async () => {},
    },

    locks: {
      /** In-process lock on the attorney's record key (original behaviour). */
      async acquire({ recordKey }) {
        const key = normalizeId(recordKey);
        if (sending.has(key)) throw new AppError(409, 'SEND_IN_PROGRESS', 'An email to this attorney is already being sent. Please wait.');
        sending.add(key);
        // Same interface as the MongoDB claim; within one process the lock is all that is needed.
        return { id: null, durable: false, begin: async () => {}, finish: async () => true, release: async () => sending.delete(key) };
      },
      sweep: async () => 0,
    },

    activity: {
      record: async () => null,
      list: async () => ({ items: [], total: 0 }),
    },

    async close() {},
  };
}
