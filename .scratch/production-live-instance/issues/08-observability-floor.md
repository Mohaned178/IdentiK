# 08: Set the observability floor

Type: grilling

Status: claimed

## Question

What is the minimum observability that lets one operator keep this Instance live — and what is explicitly deferred? The settled floor is: container stdout logs with rotation caps, a free external uptime probe on `/health/ready` alerting the operator, and a documented "how to check the Instance" (health endpoints, `docker compose ps`/`logs`, backup freshness). Metrics, tracing, log aggregation, and alerting infrastructure are deferred.

Resolve: confirm the app's current log output is adequate as-is or needs a stated change, the rotation cap values, which external prober to use, the alert channel (ask the human — email to the operator is the default guess), probe interval and what counts as "down," and the contents of the how-to-check note. Placement to confirm: all of the above required-for-live, everything fancier deferred.
