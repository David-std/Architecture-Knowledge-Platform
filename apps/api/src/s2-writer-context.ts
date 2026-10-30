import {
  ContextPacket,
  type ContextPacket as ContextPacketData,
} from "@akp/contracts";
import {
  pathMatchesVaultPrefix,
  resolveAuthorizedVaultScope,
  type Postgres,
} from "@akp/postgres";
import type { GovernedLayeredPropositionPort } from "@akp/retrieval";
import { actorOf, hasSpaceAccess } from "./auth.js";

/**
 * Exactly one authenticated, current-revision, scoped ContextPacket loader for
 * both offline Writer auditing and the opt-in native Writer evaluator.
 * Checks here are a necessary condition, NEVER semantic admission.
 */
export type S2WriterPrincipal = NonNullable<ReturnType<typeof actorOf>>;
export type S2WriterContextResult =
  | {
      ok: true;
      packet: ContextPacketData;
      port: GovernedLayeredPropositionPort;
    }
  | { ok: false; status: 403 | 404 | 409; code: string };
export async function resolveS2WriterContext(input: {
  db: Postgres;
  principal: S2WriterPrincipal;
  packetId: string;
  packetHash: string;
  trustedPort: GovernedLayeredPropositionPort;
}): Promise<S2WriterContextResult> {
  const { db, principal, packetId, packetHash, trustedPort } = input;
  const result = await db.pool.query<{
    id: string;
    space_id: string;
    packet_hash: string;
    packet: unknown;
  }>(
    `select id,space_id,packet_hash,packet from context_packets
      where id=$1 and actor_id=$2
        and (expires_at is null or expires_at>now())
      limit 1`,
    [packetId, principal.id],
  );
  const row = result.rows[0];
  if (!row || row.packet_hash !== packetHash)
    return { ok: false, status: 404, code: "S2_FROZEN_CONTEXT_NOT_FOUND" };
  const parsed = ContextPacket.safeParse(row.packet);
  if (!parsed.success)
    return { ok: false, status: 409, code: "S2_CONTEXT_PACKET_INVALID" };
  const packet = parsed.data;
  if (
    packet.packetId !== row.id ||
    packet.packetHash !== row.packet_hash ||
    packet.scope.spaceId !== row.space_id ||
    packet.sections.length > 16 ||
    packet.query.trim().length < 1 ||
    packet.query.length > 4096 ||
    packet.status !== "SUPPORTED" ||
    packet.mode !== "SOURCE_BACKED" ||
    !hasSpaceAccess(principal, row.space_id, "eval:run") ||
    !hasSpaceAccess(principal, row.space_id, "source:read")
  )
    return { ok: false, status: 403, code: "S2_WRITER_SCOPE_DENIED" };
  let scope: Awaited<ReturnType<typeof resolveAuthorizedVaultScope>>;
  try {
    scope = await resolveAuthorizedVaultScope(db, {
      userId: principal.id,
      spaceId: row.space_id,
      permission: "source:read",
      vaultIds: packet.scope.vaultIds,
      federated: packet.scope.federated,
    });
  } catch {
    return { ok: false, status: 403, code: "S2_WRITER_SCOPE_DENIED" };
  }
  for (const section of packet.sections) {
    const prefix = scope.accessByVault[section.vaultId]?.pathPrefix;
    if (
      prefix === undefined ||
      !pathMatchesVaultPrefix(section.document.path, prefix)
    )
      return { ok: false, status: 403, code: "S2_WRITER_SCOPE_DENIED" };
  }
  return {
    ok: true,
    packet,
    port: {
      resolve: ({ originalQuestion, hit }) =>
        trustedPort.resolve({
          originalQuestion,
          hit,
          principalId: principal.id,
          spaceId: row.space_id,
        }),
    },
  };
}
