"use server";

import { randomUUID } from "node:crypto";
import { redirect } from "next/navigation";
import { akp } from "../../../lib/api";

function required(formData: FormData, name: string): string {
  const value = String(formData.get(name) ?? "").trim();
  if (!value) throw new Error(`PROVIDER_REF_${name.toUpperCase()}_REQUIRED`);
  return value;
}

function href(
  sessionId: string,
  key?: "notice" | "error",
  value?: string,
): string {
  const base = `/sessions/${encodeURIComponent(sessionId)}`;
  if (!key || !value) return base;
  return `${base}?${key}=${encodeURIComponent(value)}`;
}

export async function linkProviderReference(formData: FormData) {
  const sessionId = required(formData, "sessionId");
  try {
    await akp(`/v1/sessions/${encodeURIComponent(sessionId)}/provider-refs`, {
      method: "POST",
      headers: {
        "idempotency-key": `web-provider-link-${randomUUID()}`,
      },
      body: JSON.stringify({
        connectorId: required(formData, "connectorId"),
        objectId: required(formData, "objectId"),
        workObjectClass:
          String(formData.get("workObjectClass") ?? "").trim() || "WORK_ITEM",
      }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    redirect(href(sessionId, "error", message));
  }
  redirect(href(sessionId, "notice", "Provider reference linked"));
}
