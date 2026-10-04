import { describe, expect, it } from "vitest";
import { projectRequestedAnswerSlot } from "../src/requested-answer-slot.js";

describe("projectRequestedAnswerSlot", () => {
  it.each([
    [
      "Which service emits audit events to the archive?",
      {
        role: "SUBJECT",
        relationAnchor: "emits",
        boundArgumentAnchors: ["audit", "events", "to", "archive"],
        language: "EN",
        derivation: "SURFACE_GRAMMAR",
      },
    ],
    [
      "Who reviews release exceptions before deployment?",
      {
        role: "SUBJECT",
        relationAnchor: "reviews",
        boundArgumentAnchors: ["release", "exceptions", "before", "deployment"],
        language: "EN",
        derivation: "SURFACE_GRAMMAR",
      },
    ],
    [
      "What artifact does gateway publish to the registry?",
      {
        role: "OBJECT",
        relationAnchor: "publish",
        boundArgumentAnchors: ["gateway", "to", "registry"],
        language: "EN",
        derivation: "SURFACE_GRAMMAR",
      },
    ],
    [
      "Qué servicio emite eventos hacia archivo?",
      {
        role: "SUBJECT",
        relationAnchor: "emite",
        boundArgumentAnchors: ["eventos", "hacia", "archivo"],
        language: "ES",
        derivation: "SURFACE_GRAMMAR",
      },
    ],
    [
      "Who is the designated custodian of the audit ledger?",
      {
        role: "RELATION_VALUE",
        relationAnchor: "custodian",
        boundArgumentAnchors: ["audit", "ledger"],
        language: "EN",
        derivation: "SURFACE_GRAMMAR",
      },
    ],
    [
      "Quién es el responsable de la cola crítica?",
      {
        role: "RELATION_VALUE",
        relationAnchor: "responsable",
        boundArgumentAnchors: ["cola", "critica"],
        language: "ES",
        derivation: "SURFACE_GRAMMAR",
      },
    ],
    [
      "Where does collector persist telemetry?",
      {
        role: "LOCATION",
        relationAnchor: "persist",
        boundArgumentAnchors: ["collector", "telemetry"],
        language: "EN",
        derivation: "SURFACE_GRAMMAR",
      },
    ],
    [
      "Dónde almacena agente métricas?",
      {
        role: "LOCATION",
        relationAnchor: "almacena",
        boundArgumentAnchors: ["agente", "metricas"],
        language: "ES",
        derivation: "SURFACE_GRAMMAR",
      },
    ],
  ])("projects %s", (query, expected) => {
    expect(projectRequestedAnswerSlot(query)).toEqual(expected);
  });

  it.each([
    "Why does gateway retry?",
    "How does the worker recover?",
    "When does deployment start?",
    "Por qué reintenta el gateway?",
    "Cómo se recupera el worker?",
    "Cuándo inicia el despliegue?",
    "Explain the deployment pipeline.",
  ])("fails closed for unsupported form: %s", (query) => {
    expect(projectRequestedAnswerSlot(query)).toBeNull();
  });
});
