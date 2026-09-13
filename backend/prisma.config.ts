import type { PrismaConfig } from 'prisma/config';

// Type-only import: the release artifact ships this file without node_modules,
// so the config must not require `prisma/config` at load time. The datasource
// URL is read from the environment rather than through `env()` so that
// generation, build, and typecheck work without a database: only
// `migrate`/`introspect` need DATABASE_URL, and they fail loudly when it is
// absent.
export default {
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: process.env.DATABASE_URL ?? '',
  },
} satisfies PrismaConfig;
