# 10: Fix the host baseline

Type: grilling

Status: ready-for-agent

## Question

What is the minimal host-hardening checklist the VPS must satisfy before anything deploys onto it — firewall allowing only 22/80/443, key-only SSH, unattended security updates, Docker from the official repo — and what is explicitly beyond it (intrusion detection, audit daemons, CIS hardening)?

Resolve the exact checklist with the rationale that the host is part of the trust fabric now, and confirm placement: the minimal list required-for-live, everything beyond deferred. This ticket decides the checklist; executing it on the provisioned VPS belongs to the follow-on effort.
