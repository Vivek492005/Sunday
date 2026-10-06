# Sunday Protocol Versioning

The `sundayd` JSON-RPC protocol is versioned. Every breaking change to the
contract bumps `protocolVersion`; clients must check compatibility on connect.

## Compatibility matrix

| sundayd version | Extension version | Protocol version | Notes |
|---|---|---|---|
| 1.0.0-beta.1 | 1.0.0-beta.1 | 1 | Initial beta contract |

## Rules

1. **Additive changes** (new optional methods, new optional fields) do NOT bump
   the major protocol version — they bump the minor.
2. **Breaking changes** (removed/renamed methods, changed required fields,
   new error semantics) bump the major protocol version.
3. Every breaking change MUST be listed here with the commit that introduced it.
4. CI fails if the protocol surface changes without a version bump
   (see `.github/workflows/protocol-check.yml`).

## Current protocol version: `1.0`

Declared in `packages/sundayd/src/protocol.ts` as `PROTOCOL_VERSION`.
