# 07: Set the backup and restore posture

Type: grilling

Status: ready-for-agent

Blocked by: 02, 15

## Question

Given the pgdata volume layout (ticket 02) and the prepared off-host destination (ticket 15), what is the exact backup and restore story? The settled posture: nightly `pg_dump` to a volume-mounted directory, copied off-host, RPO ≤ 24h accepted for dogfooding, PITR deferred — with the restore procedure documented **and actually drilled once** before the Instance counts as live, and the host `.env` (signing keys included, per ticket 06) in backup scope.

Resolve: dump format and schedule mechanism (cron on host vs a scheduler container), retention count on- and off-host, the off-host copy mechanism, the step-by-step restore procedure against a fresh volume, who runs the drill and what "passed" means, and what changes when real users arrive. Confirm placement: all of it required-for-live except the real-user graduation, which is fog.
