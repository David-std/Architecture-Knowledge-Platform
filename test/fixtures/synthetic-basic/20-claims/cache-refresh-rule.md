---
id: SYN-CACHE-RULE
type: rule
title: Cache Refresh Rule
aliases:
  - ERR-NMB-042
  - Nimbus cache protocol
status: active
knowledge_layer: rule
trust_tier: human-reviewed
supports:
  - SRC-SYN-NIMBUS-001
---

# Cache Refresh Rule

After a configuration change, invalidate the Nimbus cache before serving the
new configuration. Error code `ERR-NMB-042` identifies a missed refresh.
