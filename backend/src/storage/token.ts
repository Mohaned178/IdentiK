import type { PrismaService } from './prisma.service';

export const DATABASE = Symbol('DATABASE');

/**
 * The Instance's injected data client: the ORM client (ADR-0026, ADR-0027).
 * Services use typed models and `$transaction`; raw SQL is limited to the two
 * documented exceptions.
 */
export type Database = PrismaService;
