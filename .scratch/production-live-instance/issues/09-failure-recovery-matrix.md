# 09: Write the failure and recovery matrix

Type: grilling

Status: ready-for-agent

Blocked by: 02, 05, 07

## Question

Given the stack (ticket 02), the runbook (ticket 05), and the backup story (ticket 07), what happens in every scenario that can take the Instance down — VPS reboot, process crash, bad deploy, database loss/corruption, disk full, secret loss, relay outage — with detection, recovery steps, and expected downtime stated for each?

Resolve the matrix plus the drill plan: reboot, restore-from-backup, and bad-deploy rollback are **drilled** before go-live (state what each drill proves); the rest are documented-only for now. State the drills' pass criteria and where the matrix lives (operator runbook in the repo). Confirm placement: drilled half required-for-live, documented-only half required as prose.
