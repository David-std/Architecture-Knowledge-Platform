-- Extend the durable integration-event vocabulary with the explicit stale
-- transition used by revision-aware graph consumers. The active projection may
-- remain queryable in degraded mode while a replacement is rebuilt.
alter table event_outbox
  drop constraint if exists event_outbox_event_type_check;

alter table event_outbox
  add constraint event_outbox_event_type_check
  check (
    event_type in (
      'SourceRegistered',
      'ExtractionRequested',
      'ExtractionCompleted',
      'CompilationRequested',
      'KnowledgeDraftCreated',
      'ValidationRequested',
      'KnowledgePublished',
      'CorpusRevisionPublished',
      'LexicalIndexUpdateRequested',
      'VectorIndexUpdateRequested',
      'GraphIndexUpdateRequested',
      'GraphRevisionBuilt',
      'GraphRevisionActivated',
      'GraphRevisionStale',
      'ContextPackInvalidationRequested',
      'ImpactedEvalRunRequested',
      'WorkspaceSessionCreated',
      'WorkspaceSessionUpdated',
      'WorkspaceClaimUpdated',
      'WorkspaceHandoffCreated',
      'WorkspacePromotionRequested',
      'ExternalObjectRefUpserted',
      'OfflineDraftQueued',
      'OfflineDraftReconciled',
      'ContextFabricPeerRegistered',
      'PrincipalRevoked'
    )
  );
