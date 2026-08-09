import "dotenv/config";
import { createHash } from "node:crypto";
import pg from "pg";

const databaseUrl = process.env.DATABASE_URL;
const token = process.env.AKP_API_TOKEN;
const scopeJson = process.env.AKP_API_TOKEN_SCOPES;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");
if (!token || token.length < 24 || token === "dev-admin-token") {
  throw new Error(
    "AKP_API_TOKEN must be a non-default secret of at least 24 characters.",
  );
}
if (!scopeJson) {
  throw new Error(
    "AKP_API_TOKEN_SCOPES is required. Persist explicit least-privilege token scopes rather than inheriting all memberships.",
  );
}
let scopes: unknown;
try {
  scopes = JSON.parse(scopeJson);
} catch {
  throw new Error("AKP_API_TOKEN_SCOPES must be valid JSON.");
}

const permissions = new Set([
  "knowledge:read",
  "source:read",
  "source:write",
  "knowledge:propose",
  "knowledge:review",
  "eval:run",
  "admin",
]);
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function canonicalPathPrefix(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new Error(
      "Each token scope pathPrefix must be null or a relative path.",
    );
  }
  const normalized = value.replaceAll("\\", "/").replace(/\/+$/, "");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized
      .split("/")
      .some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error(
      "Token scope pathPrefix must be a non-empty relative path without dot segments.",
    );
  }
  return normalized;
}

function validateScopes(value: unknown): {
  spaces: Array<{
    spaceId: string;
    pathPrefix: string | null;
    permissions: string[];
  }>;
} {
  if (
    !value ||
    typeof value !== "object" ||
    !Array.isArray((value as { spaces?: unknown }).spaces)
  ) {
    throw new Error(
      "AKP_API_TOKEN_SCOPES must be an object with a non-empty spaces array.",
    );
  }
  const spaces = (value as { spaces: unknown[] }).spaces.map((candidate) => {
    if (!candidate || typeof candidate !== "object") {
      throw new Error("Each token scope must be an object.");
    }
    const scope = candidate as Record<string, unknown>;
    if (typeof scope.spaceId !== "string" || !uuid.test(scope.spaceId)) {
      throw new Error("Each token scope requires a valid UUID spaceId.");
    }
    if (!("pathPrefix" in scope)) {
      throw new Error(
        "Each token scope must declare pathPrefix explicitly (null for whole-space).",
      );
    }
    if (
      !Array.isArray(scope.permissions) ||
      !scope.permissions.length ||
      !scope.permissions.every(
        (item) => typeof item === "string" && permissions.has(item),
      )
    ) {
      throw new Error(
        "Each token scope requires one or more supported permissions.",
      );
    }
    return {
      spaceId: scope.spaceId,
      pathPrefix: canonicalPathPrefix(scope.pathPrefix),
      permissions: [...new Set(scope.permissions as string[])].sort(),
    };
  });
  if (!spaces.length)
    throw new Error("AKP_API_TOKEN_SCOPES.spaces cannot be empty.");
  return { spaces };
}

const validatedScopes = validateScopes(scopes);

const hash = createHash("sha256").update(token).digest("hex");
const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();
try {
  await client.query(
    `
    insert into api_tokens(user_id,token_hash,label,scopes)
    values('00000000-0000-0000-0000-000000000002',$1,'configured local token',$2::jsonb)
    on conflict(token_hash) do update set revoked_at=null,expires_at=null,scopes=excluded.scopes
    `,
    [hash, JSON.stringify(validatedScopes)],
  );
  console.log(
    JSON.stringify({
      status: "PROVISIONED",
      tokenHashPrefix: hash.slice(0, 12),
      scopes: validatedScopes,
    }),
  );
} finally {
  await client.end();
}
