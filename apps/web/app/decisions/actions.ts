"use server";

import { redirect } from "next/navigation";
import { akp } from "../../lib/api";

function required(formData: FormData, name: string): string {
  const value = String(formData.get(name) ?? "").trim();
  if (!value) throw new Error(`DECISION_${name.toUpperCase()}_REQUIRED`);
  return value;
}

function optional(formData: FormData, name: string): string | null {
  const value = String(formData.get(name) ?? "").trim();
  return value || null;
}

function lines(formData: FormData, name: string): string[] {
  return [
    ...new Set(
      String(formData.get(name) ?? "")
        .split(/\r?\n/u)
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ];
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function detailHref(sessionId: string, decisionId: string): string {
  const query = new URLSearchParams({ sessionId });
  return `/decisions/${encodeURIComponent(decisionId)}?${query.toString()}`;
}

function listHref(sessionId: string): string {
  const query = new URLSearchParams({ sessionId });
  return `/decisions?${query.toString()}`;
}

function withMessage(
  href: string,
  key: "notice" | "error",
  value: string,
): string {
  return `${href}&${key}=${encodeURIComponent(value)}`;
}

async function run<T>(href: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    redirect(withMessage(href, "error", message(error)));
  }
}

export async function createDecision(formData: FormData) {
  const sessionId = required(formData, "sessionId");
  const href = listHref(sessionId);
  const created = await run<{ id: string }>(href, () =>
    akp<{ id: string }>(`/v1/sessions/${encodeURIComponent(sessionId)}/decisions`, {
      method: "POST",
      body: JSON.stringify({
        decisionAuthorityPrincipalId: required(
          formData,
          "decisionAuthorityPrincipalId",
        ),
        title: required(formData, "title"),
        problem: required(formData, "problem"),
        context: required(formData, "context"),
        drivers: lines(formData, "drivers"),
        qualityAttributes: lines(formData, "qualityAttributes"),
        affectedRefs: lines(formData, "affectedRefs"),
        evidenceRefs: lines(formData, "evidenceRefs"),
        verificationPlan: required(formData, "verificationPlan"),
        verificationDueAt: optional(formData, "verificationDueAt"),
        decisionDeadline: optional(formData, "decisionDeadline"),
        supersedesCandidateId: optional(formData, "supersedesCandidateId"),
      }),
    }),
  );
  redirect(
    withMessage(
      detailHref(sessionId, created.id),
      "notice",
      "Decision candidate created",
    ),
  );
}

export async function addAlternative(formData: FormData) {
  const sessionId = required(formData, "sessionId");
  const decisionId = required(formData, "decisionId");
  const href = detailHref(sessionId, decisionId);
  await run(href, () =>
    akp(
      `/v1/sessions/${encodeURIComponent(sessionId)}/decisions/${encodeURIComponent(decisionId)}/alternatives`,
      {
        method: "POST",
        body: JSON.stringify({
          title: required(formData, "title"),
          description: required(formData, "description"),
          tradeoffs: required(formData, "tradeoffs"),
          evidenceRefs: lines(formData, "evidenceRefs"),
        }),
      },
    ),
  );
  redirect(withMessage(href, "notice", "Alternative added"));
}

export async function decideAlternative(formData: FormData) {
  const sessionId = required(formData, "sessionId");
  const decisionId = required(formData, "decisionId");
  const alternativeId = required(formData, "alternativeId");
  const href = detailHref(sessionId, decisionId);
  await run(href, () =>
    akp(
      `/v1/sessions/${encodeURIComponent(sessionId)}/decisions/${encodeURIComponent(decisionId)}/alternatives/${encodeURIComponent(alternativeId)}/decision`,
      {
        method: "POST",
        body: JSON.stringify({
          decision: required(formData, "decision"),
        }),
      },
    ),
  );
  redirect(withMessage(href, "notice", "Alternative decision recorded"));
}

export async function addObjection(formData: FormData) {
  const sessionId = required(formData, "sessionId");
  const decisionId = required(formData, "decisionId");
  const href = detailHref(sessionId, decisionId);
  await run(href, () =>
    akp(
      `/v1/sessions/${encodeURIComponent(sessionId)}/decisions/${encodeURIComponent(decisionId)}/objections`,
      {
        method: "POST",
        body: JSON.stringify({
          alternativeId: optional(formData, "alternativeId"),
          statement: required(formData, "statement"),
          evidenceRefs: lines(formData, "evidenceRefs"),
        }),
      },
    ),
  );
  redirect(withMessage(href, "notice", "Objection added"));
}

export async function resolveObjection(formData: FormData) {
  const sessionId = required(formData, "sessionId");
  const decisionId = required(formData, "decisionId");
  const objectionId = required(formData, "objectionId");
  const href = detailHref(sessionId, decisionId);
  await run(href, () =>
    akp(
      `/v1/sessions/${encodeURIComponent(sessionId)}/decisions/${encodeURIComponent(decisionId)}/objections/${encodeURIComponent(objectionId)}/resolve`,
      {
        method: "POST",
        body: JSON.stringify({
          resolution: required(formData, "resolution"),
        }),
      },
    ),
  );
  redirect(withMessage(href, "notice", "Objection resolved"));
}

export async function requestConsultation(formData: FormData) {
  const sessionId = required(formData, "sessionId");
  const decisionId = required(formData, "decisionId");
  const href = detailHref(sessionId, decisionId);
  await run(href, () =>
    akp(
      `/v1/sessions/${encodeURIComponent(sessionId)}/decisions/${encodeURIComponent(decisionId)}/consultations`,
      {
        method: "POST",
        body: JSON.stringify({
          reviewerPrincipalId: required(formData, "reviewerPrincipalId"),
          question: required(formData, "question"),
        }),
      },
    ),
  );
  redirect(withMessage(href, "notice", "Consultation requested"));
}

export async function respondConsultation(formData: FormData) {
  const sessionId = required(formData, "sessionId");
  const decisionId = required(formData, "decisionId");
  const consultationId = required(formData, "consultationId");
  const href = detailHref(sessionId, decisionId);
  await run(href, () =>
    akp(
      `/v1/sessions/${encodeURIComponent(sessionId)}/decisions/${encodeURIComponent(decisionId)}/consultations/${encodeURIComponent(consultationId)}/respond`,
      {
        method: "POST",
        body: JSON.stringify({
          position: required(formData, "position"),
          response: required(formData, "response"),
        }),
      },
    ),
  );
  redirect(withMessage(href, "notice", "Consultation response recorded"));
}

export async function selectAlternative(formData: FormData) {
  const sessionId = required(formData, "sessionId");
  const decisionId = required(formData, "decisionId");
  const href = detailHref(sessionId, decisionId);
  await run(href, () =>
    akp(
      `/v1/sessions/${encodeURIComponent(sessionId)}/decisions/${encodeURIComponent(decisionId)}/selection`,
      {
        method: "POST",
        body: JSON.stringify({
          alternativeId: required(formData, "alternativeId"),
          consequences: required(formData, "consequences"),
          followUpActions: lines(formData, "followUpActions"),
          effectiveFrom: optional(formData, "effectiveFrom"),
          effectiveUntil: optional(formData, "effectiveUntil"),
        }),
      },
    ),
  );
  redirect(withMessage(href, "notice", "Decision selected for review"));
}

export async function captureDecision(formData: FormData) {
  const sessionId = required(formData, "sessionId");
  const decisionId = required(formData, "decisionId");
  const href = detailHref(sessionId, decisionId);
  await run(href, () =>
    akp(
      `/v1/sessions/${encodeURIComponent(sessionId)}/decisions/${encodeURIComponent(decisionId)}/capture`,
      { method: "POST", body: JSON.stringify({}) },
    ),
  );
  redirect(withMessage(href, "notice", "Decision captured as workspace evidence"));
}

export async function promoteDecision(formData: FormData) {
  const sessionId = required(formData, "sessionId");
  const decisionId = required(formData, "decisionId");
  const href = detailHref(sessionId, decisionId);
  const promoted = await run<{ reviewId: string }>(href, () =>
    akp<{ reviewId: string }>(`/v1/sessions/${encodeURIComponent(sessionId)}/promotions`, {
      method: "POST",
      body: JSON.stringify({
        evidenceEventIds: [required(formData, "capturedEventId")],
        summary: required(formData, "summary"),
        changes: [
          {
            path: required(formData, "path"),
            content: required(formData, "content"),
            reason: required(formData, "reason"),
          },
        ],
      }),
    }),
  );
  redirect(`/reviews/${encodeURIComponent(promoted.reviewId)}`);
}
