-- Persist the federation protocol version a peer is expected to speak.
-- The peer's existing space_id and discovery_mode are the allowed scope/mode
-- contract; outbound calls must enforce them before resolving credentials or
-- contacting the network.
alter table context_fabric_peers
  add column context_api_version integer not null default 1;

alter table context_fabric_peers
  add constraint context_fabric_peers_context_api_version_check
  check (context_api_version between 1 and 32767);

comment on column context_fabric_peers.context_api_version is
  'Federation Context API schema version expected for this peer. The current executable remote-query contract is version 1.';

comment on column context_fabric_peers.space_id is
  'Allowed local space scope for this peer registration. Outbound federation must not send another space to the peer.';

comment on column context_fabric_peers.discovery_mode is
  'Allowed federation mode for this peer registration.';
