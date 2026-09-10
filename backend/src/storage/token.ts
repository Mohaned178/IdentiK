import type { DatabaseSync } from 'node:sqlite';

export const DATABASE = Symbol('DATABASE');

export type Database = DatabaseSync;
