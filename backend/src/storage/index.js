import { createFileStorage } from './file.js';
import { createMongoStorage } from './mongo.js';

/**
 * File storage unless MONGODB_URI is set. The connection string stays on the
 * backend: it is never logged or sent to the browser.
 */
export function createStorage(config, dataDir) {
  if (config.mongodb?.uri) return createMongoStorage({ uri: config.mongodb.uri, dbName: config.mongodb.dbName, dataDir });
  return createFileStorage(dataDir);
}
