# 03: Define the reverse-proxy and TLS posture

Type: grilling

Status: ready-for-agent

Blocked by: 02, 13

## Question

Given the compose layout (ticket 02) and the real hostname (ticket 13), what is the exact Caddy configuration — automatic HTTPS for the origin, HTTP→HTTPS redirect owned by the proxy (never in-app, per the floor), proxying to `app`, and the precise `IDENTIK_TRUST_PROXY` value for the compose hop so throttle keys and audit sources stay honest without ever trusting the open internet?

Resolve the Caddyfile shape, the trust value with its rationale against the stack network, and renewal/expiry behavior (what Caddy does on its own, what the operator must notice). Confirm placement: required-for-live.
