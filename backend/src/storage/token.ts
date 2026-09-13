import type { StatementSync } from 'node:sqlite';
import type { DataAccess } from './data-access';

export const DATABASE = Symbol('DATABASE');

/**
 * The Instance's data handle. During the engine swap it is the async contract
 * plus the legacy synchronous prepared-statement surface that unconverted
 * modules still use; the engine swap removes the synchronous half and
 * re-points this alias at the PostgreSQL compatibility layer.
 */
export interface Database extends DataAccess {
  prepare(sql: string): StatementSync;
}
