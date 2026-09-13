import type { PrismaService } from './prisma.service';

export const DATABASE = Symbol('DATABASE');

/**
 * The Instance's injected data handle: the ORM client (ADR-0026, ADR-0027).
 * Typed queries come first; the temporary Stage 1 facade methods still on the
 * client are deleted module by module until Finalize.
 */
export type Database = PrismaService;
