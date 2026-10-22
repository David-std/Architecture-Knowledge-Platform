import type {
  QueryTransformerPort,
  QueryTransformationInput,
  QueryTransformationResult,
} from "./query-transform.js";
import { S2BoundedQuestionCandidateTransformer } from "./s2-question-candidate-transform.js";

export const S2_BILINGUAL_CANDIDATE_SHADOW_ID =
  "s2-bilingual-candidate-shadow-v1";

/**
 * An experimental coordinator for an existing translator plus a bounded
 * lexical question probe. Translation does not become evidentiary authority.
 * Production retrieval/admission defaults are not wired to this adapter.
 */
export class S2BilingualCandidateShadowTransformer implements QueryTransformerPort {
  readonly id = S2_BILINGUAL_CANDIDATE_SHADOW_ID;
  readonly kind = "MULTI_QUERY" as const;
  private readonly local = new S2BoundedQuestionCandidateTransformer();

  constructor(private readonly translator: QueryTransformerPort) {}

  async transform(
    input: QueryTransformationInput,
  ): Promise<QueryTransformationResult> {
    const originalQuery = input.originalQuery.replace(/\s+/gu, " ").trim();
    const result: QueryTransformationResult = {
      transformerId: this.id,
      originalQuery,
      variants: [],
    };
    if (!originalQuery || originalQuery.length > 4096) return result;
    const cap = input.maxVariants ?? 6;
    if (!Number.isSafeInteger(cap) || cap < 1 || cap > 8) return result;

    const token = /[\p{L}\p{N}][\p{L}\p{M}\p{N}_:./-]*/gu;
    const initial = [...originalQuery.matchAll(token)].map((m) => m[0]);
    if (initial.length < 4 || initial.length > 48) return result;
    // Scope/negation preservation cannot be established by a simple
    // translated-word equality test. Never rewrite such questions here.
    const scopeCritical = new Set([
      "not",
      "never",
      "unless",
      "without",
      "except",
      "only",
      "before",
      "after",
      "no",
      "nunca",
      "jamás",
      "sin",
      "excepto",
      "salvo",
      "antes",
      "después",
      "ninguna",
      "ninguno",
      "si",
      "sí",
      "solo",
      "sólo",
      "more",
      "less",
      "higher",
      "lower",
      "greater",
      "fewer",
      "más",
      "menos",
      "mayor",
      "menor",
      "superior",
      "inferior",
      "than",
      "versus",
      "contra",
    ]);
    if (initial.some((value) => scopeCritical.has(value.toLocaleLowerCase())))
      return result;
    const identity = initial.filter(
      (w, index) =>
        /\p{N}/u.test(w) ||
        (/^\p{Lu}/u.test(w) &&
          !(
            index === 0 &&
            /^(?:What|When|Where|Why|How|Who|Which|Qué|Cuándo|Dónde|Por|Cuántas|Cuántos|Cuál)$/iu.test(
              w,
            )
          )),
    );
    const quoted = [...originalQuery.matchAll(/["“«]([^"”»]+)["”»]/gu)].map(
      (m) => m[1]!,
    );
    const variants: { query: string; reason: string }[] = [];
    const seen = new Set([originalQuery.toLocaleLowerCase()]);
    const add = (query: string, reason: string) => {
      const q = query.replace(/\s+/gu, " ").trim();
      const k = q.toLocaleLowerCase();
      const exactTerms = new Set(
        [...q.matchAll(token)].map((m) => m[0].replace(/[.:/-]+$/u, "")),
      );
      if (
        !q ||
        q.length > 4096 ||
        seen.has(k) ||
        identity.some((w) => !exactTerms.has(w.replace(/[.:/-]+$/u, ""))) ||
        quoted.some((s) => !q.includes(s))
      )
        return;
      seen.add(k);
      variants.push({ query: q, reason });
    };
    for (const item of (
      await this.local.transform({ originalQuery, maxVariants: 2 })
    ).variants)
      add(item.query, "DEV_SHADOW_ONLY:original-question-core");
    try {
      const translated = await this.translator.transform({
        originalQuery,
        maxVariants: 2,
      });
      if (translated.originalQuery !== originalQuery)
        throw Error("TRANSLATOR_CHANGED_ORIGINAL");
      for (const t of translated.variants.slice(0, 2)) {
        if (t.kind !== "MULTI_QUERY") continue;
        const before = variants.length;
        add(t.query, "DEV_SHADOW_ONLY:translated-candidate");
        if (variants.length === before) continue;
        const derived = await this.local.transform({
          originalQuery: t.query,
          maxVariants: 2,
        });
        for (const v of derived.variants)
          add(v.query, "DEV_SHADOW_ONLY:translated-question-core");
      }
    } catch {
      // Translation is optional and may time out; original-only candidates
      // remain, without promoting or fabricating source statements.
    }
    return {
      ...result,
      variants: variants.slice(0, cap).map((v, i) => ({
        ordinal: i + 1,
        kind: this.kind,
        query: v.query,
        reason: v.reason,
      })),
    };
  }
}
