"""Durable provider-task journal client.

The endpoint and credential are administrator-owned environment configuration;
source/request content can never select an arbitrary callback target.  When an
ingest job is supplied, failure to persist the external task association is a
hard failure rather than an untracked asynchronous task.
"""

from __future__ import annotations

import os
from typing import Any
from urllib.parse import urlparse

import httpx

from .ports import CapabilityNotConfigured, DocumentIntelligenceError


def _callback_configuration() -> tuple[str, str] | None:
    endpoint = os.getenv("AKP_PROVIDER_TASK_CALLBACK_URL", "").strip()
    token = os.getenv("AKP_PROVIDER_TASK_CALLBACK_TOKEN", "").strip()
    if not endpoint or not token:
        return None
    parsed = urlparse(endpoint)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return None
    if parsed.username or parsed.password or parsed.fragment:
        return None
    return endpoint, token


def provider_task_journal_configured() -> bool:
    return _callback_configuration() is not None


def record_provider_task_state(
    *,
    ingest_job_id: str | None,
    provider: str,
    task_id: str,
    status: str,
    task_type: str | None = None,
    mode: str | None = None,
    metadata: dict[str, Any] | None = None,
    allow_lookup_by_task: bool = False,
) -> None:
    """Persist a provider-task transition in the platform's durable ingest job.

    ``allow_lookup_by_task`` is used only for already-authenticated provider
    webhooks, where the durable mapping created at task creation time is the
    source of truth for resolving the owning ingest job.
    """

    if ingest_job_id is None and not allow_lookup_by_task:
        return
    configured = _callback_configuration()
    if configured is None:
        raise CapabilityNotConfigured(
            "Provider task journaling requires AKP_PROVIDER_TASK_CALLBACK_URL "
            "and AKP_PROVIDER_TASK_CALLBACK_TOKEN"
        )
    endpoint, token = configured
    body: dict[str, Any] = {
        "provider": provider,
        "taskId": task_id,
        "status": status,
        "metadata": metadata or {},
    }
    if ingest_job_id is not None:
        body["jobId"] = ingest_job_id
    if task_type:
        body["taskType"] = task_type
    if mode:
        body["mode"] = mode
    try:
        response = httpx.post(
            endpoint,
            headers={"x-akp-provider-task-token": token},
            json=body,
            timeout=5.0,
            follow_redirects=False,
        )
        if response.status_code not in {200, 202}:
            detail = response.text[:500]
            raise DocumentIntelligenceError(
                f"Provider task journal rejected {provider}/{task_id}: "
                f"{response.status_code} {detail}"
            )
    except DocumentIntelligenceError:
        raise
    except httpx.HTTPError as error:
        raise DocumentIntelligenceError(
            f"Provider task journal is unavailable for {provider}/{task_id}: {error}"
        ) from error
