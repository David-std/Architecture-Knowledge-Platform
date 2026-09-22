-- Federation peer revocation is a first-class durable integration event.
-- Keep the database constraint aligned with the typed event vocabulary so
-- revocation state and its outbox signal commit atomically.

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
      'CodeKnowledgeLinkApproved',
      'GraphRevisionBuilt',
      'GraphRevisionActivated',
      'GraphRevisionStale',
      'SourceWithdrawn',
      'EvidenceInvalidated',
      'FactSuperseded',
      'TruthRevisionPublished',
      'DerivedSupportInvalidationRequested',
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
      'ContextFabricPeerRevoked',
      'PrincipalRevoked'
    )
  );
