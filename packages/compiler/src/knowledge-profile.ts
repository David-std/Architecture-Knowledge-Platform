import { createHash } from "node:crypto";
import { z } from "zod";
import {
  DEFAULT_KNOWLEDGE_PROFILE_V1,
  KnowledgeProfileV1,
  canonicalKnowledgeProfileJson,
  type KnowledgeProfileV1 as KnowledgeProfileV1Type,
} from "@akp/contracts/knowledge-profile";

const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);

export const CompilerKnowledgeProfileContext = z
  .object({
    source: z.enum(["DURABLE_REVISION", "V03_DEFAULT"]),
    revisionId: z.string().uuid().nullable(),
    profileHash: Sha256,
    profile: KnowledgeProfileV1,
  })
  .strict()
  .superRefine((binding, context) => {
    if (binding.source === "DURABLE_REVISION" && !binding.revisionId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["revisionId"],
        message: "durable profile bindings require a revision id",
      });
    }
    if (binding.source === "V03_DEFAULT" && binding.revisionId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["revisionId"],
        message: "v0.3 default profile bindings cannot claim a durable revision",
      });
    }
  });
export type CompilerKnowledgeProfileContext = z.infer<
  typeof CompilerKnowledgeProfileContext
>;

export function knowledgeProfileHash(profile: unknown): string {
  return createHash("sha256")
    .update(canonicalKnowledgeProfileJson(profile))
    .digest("hex");
}

export function defaultCompilerKnowledgeProfileContext(): CompilerKnowledgeProfileContext {
  return CompilerKnowledgeProfileContext.parse({
    source: "V03_DEFAULT",
    revisionId: null,
    profileHash: knowledgeProfileHash(DEFAULT_KNOWLEDGE_PROFILE_V1),
    profile: DEFAULT_KNOWLEDGE_PROFILE_V1,
  });
}

export function durableCompilerKnowledgeProfileContext(input: {
  revisionId: string;
  profileHash: string;
  profile: unknown;
}): CompilerKnowledgeProfileContext {
  const profile = KnowledgeProfileV1.parse(input.profile);
  const computedHash = knowledgeProfileHash(profile);
  if (computedHash !== input.profileHash) {
    throw new Error("ACTIVE_KNOWLEDGE_PROFILE_HASH_MISMATCH");
  }
  return CompilerKnowledgeProfileContext.parse({
    source: "DURABLE_REVISION",
    revisionId: input.revisionId,
    profileHash: input.profileHash,
    profile,
  });
}

export function allowedCompilerKnowledgeKinds(
  profile: KnowledgeProfileV1Type,
): string[] {
  return Object.keys(profile.knowledgeKinds).sort();
}

export function assertCompilerKindAllowedByProfile(
  context: CompilerKnowledgeProfileContext,
  kind: string,
): void {
  if (!Object.hasOwn(context.profile.knowledgeKinds, kind)) {
    throw new Error(`COMPILER_PROFILE_KIND_NOT_DECLARED:${kind}`);
  }
}
