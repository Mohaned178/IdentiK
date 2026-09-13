import type { DataAccess } from './data-access';

export const DATABASE = Symbol('DATABASE');

/**
 * The Instance's data handle: the temporary Stage 1 facade over the ORM
 * client's parameterized raw access (ADR-0026, ADR-0027). Services inject it
 * exactly as they always have; Stage 2 re-points this alias at the typed
 * client and Finalize deletes the facade behind it.
 */
export type Database = DataAccess;
