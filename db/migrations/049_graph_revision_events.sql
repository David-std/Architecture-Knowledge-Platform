-- Extend the durable integration-event vocabulary for federated graph
-- projection lifecycle changes. These events are emitted transactionally with
-- graph revision build/activation so downstream consumers never observe a
-- revision pointer without the corresponding durable signal.
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
