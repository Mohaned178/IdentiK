# 13: Provision the VPS and the domain

Type: task

Status: ready-for-agent

## Question

With the human (HITL): stand up the prerequisites everything else wires into —

1. The single VPS (provider and size are the human's call; the map assumes Docker-capable Linux), with root SSH access for the operator and the host-baseline checklist (ticket 10) applied or scheduled.
2. The dedicated subdomain the Instance will serve at (e.g. `id.<domain>`), with its DNS A/AAAA record pointed at the VPS and manageable by the operator for future changes.

Hand the human a precise checklist; resolve when the VPS is reachable over SSH and the name resolves to it. Record the provider, the address, and the exact public origin (this becomes `IDENTIK_BASE_URL`). Blocked work waits on this: the proxy config (ticket 03) needs the hostname, deploy and observability need the host.

## Answer

*(record the VPS, the origin, and DNS state on resolution)*
