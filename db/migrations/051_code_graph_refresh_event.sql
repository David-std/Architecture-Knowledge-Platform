-- Extend the durable integration-event vocabulary with the project Code Graph
-- refresh request. The project snapshot/document write and this event commit in
-- one transaction; the durable worker performs the expensive provider work.
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
      'CodeGraphRefreshRequested',
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
