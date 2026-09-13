# 17: Record the architectural decisions

**What to build:** ADR-0026 records that PostgreSQL replaces SQLite as the Instance database, and ADR-0027 records the ORM as the data-access layer — each superseding the relevant clause of ADR-0024. ADR-0024 gains a status note pointing at its superseding records. The drafts already live in the migration spec's appendices; this ticket promotes them into the decision record.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] ADR-0026 and ADR-0027 are committed under the ADR directory, following the repository's numbering and format
- [ ] ADR-0024's status points at both superseding records
- [ ] No application code changes
