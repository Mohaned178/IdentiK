# 14: Provision the mail relay

Type: task

Status: ready-for-agent

## Question

With the human (HITL): provision the live Instance's outbound mail — a real transactional relay or SMTP provider (provider choice is the human's call), with credentials in hand and the sender-domain deliverability records (SPF, DKIM, DMARC) published so verification, reset, and invitation mail actually arrives rather than landing in spam.

Hand the human a precise checklist: provider account, SMTP host/port/credentials, `MAIL_FROM` address, and the DNS records with how to verify each. Resolve when credentials exist and the records verify, recording the relay, the sender address, and any sending limits the operator must respect. The go-live acceptance (ticket 12) will demand a real mailbox proof round-trip through this relay.

## Answer

*(record the relay, sender, records, and limits on resolution)*
