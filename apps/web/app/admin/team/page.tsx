import { randomUUID } from "node:crypto";
import Link from "next/link";
import { revalidatePath } from "next/cache";
import { akp, akpOptional } from "../../../lib/api";

type Scope = {
  spaceId: string;
  pathPrefix: string | null;
  permissions: string[];
};

type TeamResponse = {
  generatedAt: string;
  scope: { spaces: string[]; vaultIds: string[] };
  spaces: Array<{
    id: string;
    organization_id: string;
    slug: string;
    name: string;
    visibility: string;
    created_at: string;
  }>;
  vaults: Array<{
    id: string;
    space_id: string;
    vault_key: string;
    name: string;
    visibility: string;
    enabled: boolean;
    current_revision: string | null;
  }>;
  memberships: Array<{
    id: string;
    user_id: string;
    space_id: string;
    role: string;
    path_prefix: string | null;
    email: string;
    display_name: string;
  }>;
  principals: Array<{
    id: string;
    kind: string;
    user_id: string | null;
    parent_principal_id: string | null;
    session_id: string | null;
    vault_id: string | null;
    display_name: string;
    allowed_actions: string[];
    policy_revision: number;
    state: string;
    created_at: string;
    revoked_at: string | null;
  }>;
  apiCredentials: Array<{
    id: string;
    kind: "API_TOKEN";
    userId: string;
    email: string;
    displayName: string;
    label: string;
    scopes: Scope[];
    expiresAt: string | null;
    revokedAt: string | null;
    createdAt: string;
    revocable: boolean;
    crossScope: boolean;
  }>;
  principalCredentials: Array<{
    id: string;
    kind: "PRINCIPAL_CREDENTIAL";
    principalId: string;
    principalKind: string;
    principalName: string;
    principalState: string;
    vaultId: string;
    sessionId: string | null;
    label: string;
    scopes: Scope[];
    allowedActions: string[];
    policyRevision: number;
    expiresAt: string;
    revokedAt: string | null;
    createdAt: string;
    revocable: boolean;
    crossScope: boolean;
  }>;
};

type WorkspaceHome = {
  pendingReviews: Array<{
    id: string;
    vault_id: string;
    status: string;
    created_at: string;
    updated_at: string;
  }>;
  activeSessions: Array<{
    id: string;
    vault_id: string;
    purpose: string;
    revision_set_hash: string | null;
    pinned_at: string | null;
    updated_at: string;
  }>;
};

type Health = {
  indexes: Array<{
    vault_id: string;
    corpus_revision: string | null;
    lexical_revision: string | null;
    vector_revision: string | null;
    graph_revision: string | null;
    context_pack_revision: string | null;
    status: string;
    warnings: string[];
  }>;
  connectors: Array<{
    id: string;
    vault_id: string;
    connector_key: string;
    source_system: string;
    state: string;
    applied_sequence: number | string;
    pending_events: number;
    gap_events: number;
    uncertain_acl_objects: number;
    tombstones: number;
    last_event_at: string | null;
  }>;
  assurance: {
    openFindings: Array<{
      id: string;
      vault_id: string;
      severity: string;
      detector: string;
      code: string;
      summary: string;
      status: string;
      last_seen_at: string;
    }>;
  };
};

type ProfilesResponse = {
  active: {
    source: string;
    revisionId: string | null;
    profileId: string;
    version: string;
    profileHash: string;
    status: string;
  };
  revisions: Array<{ id: string; status: string }>;
};

type FederationResponse = {
  peers: Array<{
    id: string;
    spaceId: string | null;
    peerKey: string;
    displayName: string;
    discoveryMode: string;
    trustState: string;
    revision: string | null;
    lastSeenAt: string | null;
    compatibility: unknown;
  }>;
  boundary: string;
};

function short(value: string | null | undefined): string {
  return value ? value.slice(0, 12) : "—";
}

function scopeLabel(scopes: Scope[]): string {
  if (!scopes.length) return "—";
  return scopes
    .map(
      (scope) =>
        `${short(scope.spaceId)}:${scope.pathPrefix ?? "*"} [${scope.permissions.join(", ")}]`,
    )
    .join(" · ");
}

export default async function TeamAdminPage({
  searchParams,
}: {
  searchParams: Promise<{ vaultId?: string; notice?: string }>;
}) {
  const query = await searchParams;
  const team = await akpOptional<TeamResponse>("/v1/operator/team");
  if (!team) {
    return (
      <main>
        <p className="muted">Team Admin</p>
        <h1>Administración de equipo</h1>
        <div className="card">
          Esta vista requiere permiso administrativo sin restricción de path.
        </div>
      </main>
    );
  }

  const selected =
    team.vaults.find((vault) => vault.id === query.vaultId) ?? team.vaults[0];

  let home: WorkspaceHome | null = null;
  let health: Health | null = null;
  let profiles: ProfilesResponse | null = null;
  let federation: FederationResponse | null = null;
  if (selected) {
    [home, health, profiles, federation] = await Promise.all([
      akp<WorkspaceHome>("/v1/operator/workspace-home"),
      akp<Health>("/v1/operator/health"),
      akp<ProfilesResponse>(
        `/v1/schema/profiles?spaceId=${encodeURIComponent(selected.space_id)}&vaultId=${encodeURIComponent(selected.id)}`,
      ),
      akp<FederationResponse>(
        `/v1/context-fabric/peers?spaceId=${encodeURIComponent(selected.space_id)}&vaultId=${encodeURIComponent(selected.id)}`,
      ),
    ]);
  }

  async function revokeCredential(formData: FormData) {
    "use server";
    const id = String(formData.get("credentialId") ?? "");
    const kind = String(formData.get("kind") ?? "");
    if (!id || !["API_TOKEN", "PRINCIPAL_CREDENTIAL"].includes(kind)) {
      throw new Error("TEAM_CREDENTIAL_REQUIRED");
    }
    await akp(`/v1/operator/team/credentials/${encodeURIComponent(id)}/revoke`, {
      method: "POST",
      headers: { "idempotency-key": `web-team-revoke-${randomUUID()}` },
      body: JSON.stringify({ kind }),
    });
    revalidatePath("/admin/team");
  }

  const pendingReviews =
    home?.pendingReviews.filter((review) => review.vault_id === selected?.id) ??
    [];
  const sessions =
    home?.activeSessions.filter((session) => session.vault_id === selected?.id) ??
    [];
  const indexes =
    health?.indexes.filter((index) => index.vault_id === selected?.id) ?? [];
  const connectors =
    health?.connectors.filter(
      (connector) => connector.vault_id === selected?.id,
    ) ?? [];
  const findings =
    health?.assurance.openFindings.filter(
      (finding) => finding.vault_id === selected?.id,
    ) ?? [];

  return (
    <main>
      <p className="muted">
        Scopes, identities, credentials, governance and operational context
      </p>
      <h1>Team Admin</h1>
      {query.notice ? <p className="card">{query.notice}</p> : null}

      <div className="grid">
        <section className="card">
          <span className="muted">Spaces administrables</span>
          <p className="metric">{team.spaces.length}</p>
        </section>
        <section className="card">
          <span className="muted">Memberships</span>
          <p className="metric">{team.memberships.length}</p>
        </section>
        <section className="card">
          <span className="muted">Principals</span>
          <p className="metric">{team.principals.length}</p>
        </section>
        <section className="card">
          <span className="muted">Credentials visibles</span>
          <p className="metric">
            {team.apiCredentials.length + team.principalCredentials.length}
          </p>
        </section>
      </div>

      <h2>Scopes / spaces</h2>
      <section className="card">
        {team.spaces.length ? (
          <table>
            <thead>
              <tr>
                <th>Space</th>
                <th>Visibility</th>
                <th>Vaults</th>
              </tr>
            </thead>
            <tbody>
              {team.spaces.map((space) => (
                <tr key={space.id}>
                  <td>
                    <strong>{space.name}</strong>
                    <br />
                    <code>{short(space.id)}</code> · {space.slug}
                  </td>
                  <td>{space.visibility}</td>
                  <td>
                    {team.vaults
                      .filter((vault) => vault.space_id === space.id)
                      .map((vault) => (
                        <span key={vault.id}>
                          <Link href={`/admin/team?vaultId=${vault.id}`}>
                            {vault.name}
                          </Link>{" "}
                          <code>{short(vault.current_revision)}</code>
                          <br />
                        </span>
                      ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="muted">No unrestricted admin scopes.</p>
        )}
      </section>

      <h2>Memberships</h2>
      <section className="card">
        <table>
          <thead>
            <tr>
              <th>User</th>
              <th>Space</th>
              <th>Role</th>
              <th>Path scope</th>
            </tr>
          </thead>
          <tbody>
            {team.memberships.map((membership) => (
              <tr key={membership.id}>
                <td>
                  {membership.display_name}
                  <br />
                  <small>{membership.email}</small>
                </td>
                <td>
                  <code>{short(membership.space_id)}</code>
                </td>
                <td>{membership.role}</td>
                <td>
                  <code>{membership.path_prefix ?? "*"}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <h2>Human / service / agent principals</h2>
      <section className="card">
        <table>
          <thead>
            <tr>
              <th>Principal</th>
              <th>Kind / state</th>
              <th>Session / vault</th>
              <th>Policy / actions</th>
            </tr>
          </thead>
          <tbody>
            {team.principals.map((principal) => (
              <tr key={principal.id}>
                <td>
                  {principal.display_name}
                  <br />
                  <code>{short(principal.id)}</code>
                </td>
                <td>
                  <span className="badge">{principal.kind}</span>{" "}
                  <span className="badge">{principal.state}</span>
                </td>
                <td>
                  session <code>{short(principal.session_id)}</code>
                  <br />
                  vault <code>{short(principal.vault_id)}</code>
                </td>
                <td>
                  revision {principal.policy_revision}
                  <br />
                  <small>{principal.allowed_actions.join(" · ") || "—"}</small>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <h2>Token metadata / revocation</h2>
      <div className="card">
        <p className="muted">
          Raw tokens and token hashes are never returned. Cross-scope
          credentials are clipped to the visible scope and cannot be revoked
          here.
        </p>
        <table>
          <thead>
            <tr>
              <th>Credential</th>
              <th>Owner / principal</th>
              <th>Visible scopes</th>
              <th>Lifecycle</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {[...team.apiCredentials, ...team.principalCredentials].map(
              (credential) => (
                <tr key={credential.id}>
                  <td>
                    <span className="badge">{credential.kind}</span>
                    <br />
                    {credential.label}
                    <br />
                    <code>{short(credential.id)}</code>
                  </td>
                  <td>
                    {"principalName" in credential
                      ? credential.principalName
                      : credential.displayName}
                    <br />
                    <code>
                      {short(
                        "principalId" in credential
                          ? credential.principalId
                          : credential.userId,
                      )}
                    </code>
                  </td>
                  <td>
                    <small>{scopeLabel(credential.scopes)}</small>
                  </td>
                  <td>
                    {credential.revokedAt ? (
                      <span className="badge">REVOKED</span>
                    ) : (
                      <span className="badge">ACTIVE</span>
                    )}
                    <br />
                    <small>expires {credential.expiresAt ?? "—"}</small>
                    {credential.crossScope ? (
                      <>
                        <br />
                        <small>CROSS_SCOPE</small>
                      </>
                    ) : null}
                  </td>
                  <td>
                    {!credential.revokedAt && credential.revocable ? (
                      <form action={revokeCredential}>
                        <input
                          type="hidden"
                          name="credentialId"
                          value={credential.id}
                        />
                        <input
                          type="hidden"
                          name="kind"
                          value={credential.kind}
                        />
                        <button type="submit">
                          {"principalId" in credential
                            ? "Revoke agent"
                            : "Revoke token"}
                        </button>
                      </form>
                    ) : (
                      <span className="muted">No revocable en este scope</span>
                    )}
                  </td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      </div>

      {selected && home && health && profiles && federation ? (
        <>
          <h2>Governance · {selected.name}</h2>
          <div className="grid">
            <section className="card">
              <h3>Promotion queue</h3>
              <p className="metric">{pendingReviews.length}</p>
              {pendingReviews.slice(0, 5).map((review) => (
                <p key={review.id}>
                  <Link href={`/reviews/${review.id}`}>
                    {short(review.id)} · {review.status}
                  </Link>
                </p>
              ))}
            </section>

            <section className="card">
              <h3>Active KnowledgeProfile</h3>
              <p className="metric">{profiles.active.version}</p>
              <p>
                {profiles.active.profileId} · {profiles.active.source}
                <br />
                <code>{short(profiles.active.profileHash)}</code>
              </p>
              <Link href={`/admin/profiles?vaultId=${selected.id}`}>
                Open profile governance
              </Link>
            </section>

            <section className="card">
              <h3>Federation peers</h3>
              <p className="metric">{federation.peers.length}</p>
              <p className="muted">{federation.boundary}</p>
            </section>
          </div>

          <h2>Federation peers</h2>
          <section className="card">
            {federation.peers.length ? (
              <table>
                <thead>
                  <tr>
                    <th>Peer</th>
                    <th>Trust</th>
                    <th>Discovery</th>
                    <th>Revision / last seen</th>
                  </tr>
                </thead>
                <tbody>
                  {federation.peers.map((peer) => (
                    <tr key={peer.id}>
                      <td>
                        {peer.displayName}
                        <br />
                        <code>{peer.peerKey}</code>
                      </td>
                      <td>{peer.trustState}</td>
                      <td>{peer.discoveryMode}</td>
                      <td>
                        <code>{short(peer.revision)}</code>
                        <br />
                        <small>{peer.lastSeenAt ?? "—"}</small>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="muted">No federation peers.</p>
            )}
          </section>

          <h2>Connector status</h2>
          <section className="card">
            {connectors.length ? (
              <table>
                <thead>
                  <tr>
                    <th>Connector</th>
                    <th>State</th>
                    <th>Checkpoint</th>
                    <th>Pending / gaps / ACL</th>
                    <th>Last event</th>
                  </tr>
                </thead>
                <tbody>
                  {connectors.map((connector) => (
                    <tr key={connector.id}>
                      <td>
                        {connector.connector_key}
                        <br />
                        <small>{connector.source_system}</small>
                      </td>
                      <td>{connector.state}</td>
                      <td>{String(connector.applied_sequence)}</td>
                      <td>
                        {connector.pending_events} / {connector.gap_events} /{" "}
                        {connector.uncertain_acl_objects}
                      </td>
                      <td>{connector.last_event_at ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="muted">No connectors for this vault.</p>
            )}
          </section>

          <h2>Context revision health</h2>
          <section className="card">
            {sessions.length ? (
              <table>
                <thead>
                  <tr>
                    <th>Session</th>
                    <th>Pinned revision</th>
                    <th>Pinned at</th>
                    <th>Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {sessions.map((session) => (
                    <tr key={session.id}>
                      <td>
                        <Link href={`/sessions/${session.id}`}>
                          {session.purpose}
                        </Link>
                      </td>
                      <td>
                        <code>{short(session.revision_set_hash)}</code>
                      </td>
                      <td>{session.pinned_at ?? "LEGACY_UNPINNED"}</td>
                      <td>{session.updated_at}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="muted">No active sessions.</p>
            )}
          </section>

          <h2>Graph / index revisions</h2>
          <section className="card">
            {indexes.length ? (
              <table>
                <thead>
                  <tr>
                    <th>Status</th>
                    <th>Corpus</th>
                    <th>Lexical</th>
                    <th>Vector</th>
                    <th>Graph</th>
                    <th>Context</th>
                  </tr>
                </thead>
                <tbody>
                  {indexes.map((index) => (
                    <tr key={index.vault_id}>
                      <td>{index.status}</td>
                      <td>
                        <code>{short(index.corpus_revision)}</code>
                      </td>
                      <td>
                        <code>{short(index.lexical_revision)}</code>
                      </td>
                      <td>
                        <code>{short(index.vector_revision)}</code>
                      </td>
                      <td>
                        <code>{short(index.graph_revision)}</code>
                      </td>
                      <td>
                        <code>{short(index.context_pack_revision)}</code>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="muted">No index revision state.</p>
            )}
          </section>

          <h2>Assurance findings</h2>
          <section className="card">
            {findings.length ? (
              <table>
                <thead>
                  <tr>
                    <th>Severity</th>
                    <th>Detector</th>
                    <th>Code</th>
                    <th>Finding</th>
                    <th>Last seen</th>
                  </tr>
                </thead>
                <tbody>
                  {findings.map((finding) => (
                    <tr key={finding.id}>
                      <td>{finding.severity}</td>
                      <td>{finding.detector}</td>
                      <td>
                        <code>{finding.code}</code>
                      </td>
                      <td>{finding.summary}</td>
                      <td>{finding.last_seen_at}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="muted">No open assurance findings.</p>
            )}
          </section>
        </>
      ) : (
        <p className="card">
          No authorized vault is available for operational governance panels.
        </p>
      )}
    </main>
  );
}
