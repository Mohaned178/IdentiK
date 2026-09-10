# 20: Production SMTP transport binding

**What to build:** The instance-scoped half of the settings boundary (ADR-0022): the real outbound mail transport. The Instance Operator configures SMTP via deployment configuration — out-of-band from the dashboard, part of the trust fabric — and all platform mail (verification, reset, invitation, email-change) flows through it. The in-memory capture binding from ticket 01 remains the test binding, selectable by configuration; callers are untouched (the seam's whole point).

**Blocked by:** 03 (first real mail flows exist to bind).

**Status:** ready-for-agent

- [ ] SMTP connection details are provided via deployment configuration only — never editable from the dashboard or Management API
- [ ] All outbound platform mail (verification, reset, invitation, email change) is delivered through the configured transport
- [ ] The in-memory capture binding remains available and is selected by configuration for tests, with no caller changes
- [ ] Misconfiguration (unreachable relay) is diagnosable from startup/health without leaking secrets into logs
- [ ] Black-box tests keep running against the capture binding, proving the seam held
