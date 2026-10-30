import { describe, it, expect } from "vitest";
import { explicitlyRequestsNonBooleanAnswer } from "../src/question-answer-form.js";

describe("source-governed answer form, EN/ES", () => {
  it.each([
    "How often is each engineer on call?",
    "How often is an A-check carried out?",
    "When can I bring a regular bicycle on the metro?",
    "How many inspectors must sign?",
    "What happens to medication after an excursion?",
    "Who approves payroll?",
    "Where are documents stored?",
    "¿Cuándo hay que cambiar el aceite de la freidora?",
    "¿Cuándo puedo teletrabajar?",
    "¿En qué casos hace falta el parte oficial de baja?",
    "¿En qué casos no se puede renovar un préstamo?",
    "¿En qué momentos hay que lavarse las manos?",
    "¿Con qué frecuencia se inspecciona?",
    "¿Quién autoriza un pago?",
    "¿Cuántos días dura?",
    "¿Qué ocurre tras la revisión?",
  ])(
    "rejects boolean answers to an unambiguously nonboolean question: %s",
    (question) => {
      expect(explicitlyRequestsNonBooleanAnswer(question)).toBe(true);
    },
  );

  it.each([
    "If a SEV1 is downgraded, is a postmortem needed?",
    "When a severe alert occurs, can the engineer roll back?",
    "When the release is frozen, can the operator still deploy?",
    "Can any engineer run an engine above idle?",
    "Do kitchen staff retake the course every year?",
    "¿Es obligatorio etiquetar las preparaciones?",
    "¿Se puede remolcar con ráfagas de 50 nudos?",
    "Si la temperatura sube, ¿se debe detener el proceso?",
    "¿Tengo que contestar correos el domingo?",
    "Does a user need a receipt?",
    "Should it be released?",
    "Does this violate the rule, and why?",
    "What if the server is down?",
    "",
  ])(
    "preserves binary or ambiguous query as unknown, not a false block: %s",
    (question) => {
      expect(explicitlyRequestsNonBooleanAnswer(question)).toBe(false);
    },
  );
});
