-- Durable federation health supports bounded backoff and a process-independent
-- circuit breaker. Only machine-safe error codes are retained.
alter table context_fabric_peers
  add column failure_count integer not null default 0
    check (failure_count >= 0),
  add column circuit_open_until timestamptz,
  add column last_failure_code text,
  add column last_success_at timestamptz;

alter table context_fabric_peers
  add constraint context_fabric_peers_failure_code_check
  check (
    last_failure_code is null
    or last_failure_code ~ '^[A-Z][A-Z0-9_]*$'
  );

comment on column context_fabric_peers.circuit_open_until is
  'Do not contact this peer before this instant after repeated remote-query failures.';
comment on column context_fabric_peers.last_failure_code is
  'Machine-safe federation failure code; never a raw remote error message.';
