# SQLite (node:sqlite) as the Instance database

Status: superseded in part by ADR-0026 (PostgreSQL replaces SQLite as the Instance database) and ADR-0027 (Prisma as the Instance's data-access layer); the Organization-scope decision stands.

The Instance's persistence is a single SQLite database file under the Operator-configured state directory, accessed through Node's built-in `node:sqlite` — no ORM, no native compilation, no separate database server. Chosen for ADR-0001's "boring to operate" promise: a self-hosted first release where persistence is a file the Operator backs up alongside the config is the deployment model Keycloak-exiles dream of, and the two-seam testing contract (tests never touch storage) keeps the storage engine swappable behind the repositories if a hosted mode ever demands Postgres. All schema is Organization-scoped from day one; migrations are plain SQL applied in versioned order at boot.
