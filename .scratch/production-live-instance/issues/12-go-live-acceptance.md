# 12: Fix the go-live acceptance bar

Type: grilling

Status: ready-for-agent

Blocked by: 08, 09, 11, 14

## Question

Given the observability floor (ticket 08), the drilled recovery matrix (ticket 09), operator-API findings (ticket 11), and the live relay (ticket 14), what exactly must be demonstrated — and in what order — before the Instance counts as live? The proposed bar: reachable at the https origin, bootstrap completed, a real mailbox proof round-trip against a real mailbox, a backup sitting off-host, restore + reboot + rollback drills passed, uptime probe green, runbook executed once by hand.

Resolve the final checklist with pass criteria per item, the order of demonstration, and who signs off. This ticket closes the map's decision space: after it, nothing remains to decide before the follow-on execution effort. Confirm each item's required-for-live placement.
