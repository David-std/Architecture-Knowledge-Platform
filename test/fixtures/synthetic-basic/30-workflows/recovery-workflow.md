---
id: SYN-RECOVERY-WORKFLOW
type: workflow
title: Snapshot Recovery Workflow
status: active
knowledge_layer: workflow
trust_tier: human-reviewed
requires:
  - SRC-SYN-NIMBUS-001
---

# Snapshot Recovery Workflow

1. Restore the immutable snapshot.
2. Verify the restored checksum against the manifest.
3. Start the service in read-only mode.
4. Promote only after the health probe succeeds.
