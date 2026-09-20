-- P2.19 canonical activity derivation vocabulary.
--
-- Keep legacy persisted values accepted during the v0.4 migration window, but
-- add the six contract-level epistemic classes explicitly. The causal guard
-- remains fail-closed: ordering, correlation, and inferred hypotheses cannot
-- assert CAUSED.

alter table work_activity_events
  drop constraint if exists work_activity_events_derivation_check;

alter table work_activity_events
  add constraint work_activity_events_derivation_check
  check (
    derivation in (
      'SOURCE_EXPLICIT',
      'OBSERVED_ORDER',
      'CORRELATED',
      'INFERRED_HYPOTHESIS',
      'HUMAN_APPROVED_CAUSAL',
      'DYNAMICALLY_PROVEN',
      'OBSERVED_CORRELATION',
      'MODEL_INFERRED',
      'HUMAN_ASSERTED'
    )
  );

alter table work_activity_events
  drop constraint if exists work_activity_events_causality_requires_support;

alter table work_activity_events
  add constraint work_activity_events_causality_requires_support
  check (
    action <> 'CAUSED'
    or derivation in (
      'SOURCE_EXPLICIT',
      'HUMAN_APPROVED_CAUSAL',
      'DYNAMICALLY_PROVEN',
      'HUMAN_ASSERTED'
    )
  );

comment on column work_activity_events.derivation is
  'Epistemic derivation. Canonical v0.4 values distinguish explicit source, observed order, correlation, inferred hypothesis, human-approved causal evidence, and dynamic proof; legacy values remain migration-compatible.';
