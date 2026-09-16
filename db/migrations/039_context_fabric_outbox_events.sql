-- Extend the durable integration-event contract for P2 team-context fabric.
-- Workspace coordination remains append-only in workspace_events; these outbox
-- events expose transactionally committed lifecycle boundaries to other
-- processes without making workspace state canonical knowledge.

alter table event_outbox
  drop constraint if exists event_outbox_event_type_check;

alter table event_outbox
  add constraint event_outbox_event_type_check check (event_type in (
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
    'ContextPackInvalidationRequested',
    'ImpactedEvalRunRequested',
    'WorkspaceSessionCreated',
    'WorkspaceClaimUpdated',
    'WorkspaceHandoffCreated',
    'WorkspacePromotionRequested',
    'ExternalObjectRefUpserted',
    'OfflineDraftQueued',
    'OfflineDraftReconciled',
    'ContextFabricPeerRegistered'
  ));
