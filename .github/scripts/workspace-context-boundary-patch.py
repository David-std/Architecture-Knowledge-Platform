import base64
import json
import re
import subprocess
import zlib
from pathlib import Path

workflow = Path(".github/workflows/workspace-context-preflight.yml").read_text()
match = re.search(r'payload = "([A-Za-z0-9+/=]+)"', workflow)
if not match:
    raise SystemExit("embedded materializer payload not found")

script = zlib.decompress(base64.b64decode(match.group(1))).decode()
old_loop = (
    "# Same select shape occurs in list and snapshot; patch remaining occurrences.\n"
    "for _ in range(2):"
)
new_loop = (
    "# The current source has one remaining matching select (list); snapshot uses a distinct query.\n"
    "for _ in range(1):"
)
if script.count(old_loop) != 1:
    raise SystemExit(f"unexpected materializer loop count: {script.count(old_loop)}")
script = script.replace(old_loop, new_loop, 1)
Path("/tmp/workspace-context-materialize.py").write_text(script)
subprocess.run(["python", "/tmp/workspace-context-materialize.py"], check=True)

fp = json.loads(Path("/tmp/default-context-fingerprints.json").read_text())
module_path = Path("packages/postgres/src/context-revision-set.ts")
text = module_path.read_text()

contracts_import = re.compile(
    r'import \{\s*DEFAULT_KNOWLEDGE_PROFILE_V1,\s*canonicalKnowledgeProfileJson,\s*\} from "@akp/contracts/knowledge-profile";\n',
    re.MULTILINE,
)
text, count = contracts_import.subn("", text, count=1)
if count != 1:
    raise SystemExit(f"contracts import patch count={count}")

defaults = re.compile(
    r"const DEFAULT_PROFILE_CANONICAL = canonicalKnowledgeProfileJson\(\s*DEFAULT_KNOWLEDGE_PROFILE_V1,\s*\);\n"
    r"const DEFAULT_PROFILE_HASH = sha256\(DEFAULT_PROFILE_CANONICAL\);"
)
replacement = "\n".join(
    [
        f"const DEFAULT_PROFILE_ID = {json.dumps(fp['profileId'])};",
        f"const DEFAULT_PROFILE_VERSION = {json.dumps(fp['version'])};",
        f"const DEFAULT_PROFILE_HASH = {json.dumps(fp['profileHash'])};",
        f"const DEFAULT_POLICY_REVISION = {json.dumps(fp['policyRevision'])};",
    ]
)
text, count = defaults.subn(replacement, text, count=1)
if count != 1:
    raise SystemExit(f"default constants patch count={count}")

text, count = re.subn(
    r"function policyRevision\(profile: Record<string, unknown>\): string \{",
    "export function contextPolicyRevisionFromProfile(\n  profile: Record<string, unknown>,\n): string {",
    text,
    count=1,
)
if count != 1:
    raise SystemExit(f"policy helper patch count={count}")

old_signature = "\n".join(
    [
        "function profileIdentity(row: ContextRevisionRow): {",
        "  identity: ContextProfileRevision;",
        "  profile: Record<string, unknown>;",
        "} {",
    ]
)
new_signature = "\n".join(
    [
        "function profileIdentity(row: ContextRevisionRow): {",
        "  identity: ContextProfileRevision;",
        "  policyRevision: string;",
        "} {",
    ]
)
if text.count(old_signature) != 1:
    raise SystemExit(f"profileIdentity signature count={text.count(old_signature)}")
text = text.replace(old_signature, new_signature, 1)

old_default = "\n".join(
    [
        "        profileId: DEFAULT_KNOWLEDGE_PROFILE_V1.profileId,",
        "        version: DEFAULT_KNOWLEDGE_PROFILE_V1.version,",
        "        hash: DEFAULT_PROFILE_HASH,",
        "      },",
        "      profile: DEFAULT_KNOWLEDGE_PROFILE_V1 as unknown as Record<string, unknown>,",
    ]
)
new_default = "\n".join(
    [
        "        profileId: DEFAULT_PROFILE_ID,",
        "        version: DEFAULT_PROFILE_VERSION,",
        "        hash: DEFAULT_PROFILE_HASH,",
        "      },",
        "      policyRevision: DEFAULT_POLICY_REVISION,",
    ]
)
if text.count(old_default) != 1:
    raise SystemExit(f"default identity patch count={text.count(old_default)}")
text = text.replace(old_default, new_default, 1)

old_durable = "\n".join(
    [
        "    },",
        "    profile: parseProfile(row.canonical_profile),",
        "  };",
        "}",
    ]
)
new_durable = "\n".join(
    [
        "    },",
        "    policyRevision: contextPolicyRevisionFromProfile(",
        "      parseProfile(row.canonical_profile),",
        "    ),",
        "  };",
        "}",
    ]
)
if text.count(old_durable) != 1:
    raise SystemExit(f"durable profile patch count={text.count(old_durable)}")
text = text.replace(old_durable, new_durable, 1)

old_policy = "      revision: policyRevision(profile.profile),"
if text.count(old_policy) != 1:
    raise SystemExit(f"policy revision use count={text.count(old_policy)}")
text = text.replace(old_policy, "      revision: profile.policyRevision,", 1)

if (
    "@akp/contracts" in text
    or "DEFAULT_KNOWLEDGE_PROFILE_V1" in text
    or "canonicalKnowledgeProfileJson" in text
):
    raise SystemExit("postgres module still references semantic contracts authority")
module_path.write_text(text)

test_path = Path("apps/api/test/context-revision-set.integration.test.ts")
test = test_path.read_text()

if "DEFAULT_KNOWLEDGE_PROFILE_V1" not in test:
    marker = "  NEUTRAL_KNOWLEDGE_PROFILE_V1,\n"
    if test.count(marker) != 1:
        raise SystemExit(f"test contracts import anchor count={test.count(marker)}")
    test = test.replace(marker, "  DEFAULT_KNOWLEDGE_PROFILE_V1,\n" + marker, 1)

if "contextPolicyRevisionFromProfile" not in test:
    marker = "  Postgres,\n"
    if test.count(marker) != 1:
        raise SystemExit(f"test postgres import anchor count={test.count(marker)}")
    test = test.replace(
        marker,
        marker + "  contextPolicyRevisionFromProfile,\n",
        1,
    )

old_type = "profile: { source: string; revisionId: string | null; profileId: string };"
new_type = (
    "profile: { source: string; revisionId: string | null; profileId: string; "
    "version: string; hash: string };"
)
if test.count(old_type) != 1:
    raise SystemExit(f"test profile type anchor count={test.count(old_type)}")
test = test.replace(old_type, new_type, 1)

old_expect = "\n".join(
    [
        "    expect(initial.contextRevisionSet.profile).toMatchObject({",
        '      source: "DEFAULT",',
        "      revisionId: null,",
        '      profileId: "default",',
        "    });",
        "    expect(initial.contextRevisionSet.policy.revision).toMatch(/^[a-f0-9]{64}$/);",
    ]
)
new_expect = "\n".join(
    [
        "    const defaultCanonical = canonicalKnowledgeProfileJson(",
        "      DEFAULT_KNOWLEDGE_PROFILE_V1,",
        "    );",
        '    const defaultProfileHash = createHash("sha256")',
        "      .update(defaultCanonical)",
        '      .digest("hex");',
        "    expect(initial.contextRevisionSet.profile).toMatchObject({",
        '      source: "DEFAULT",',
        "      revisionId: null,",
        "      profileId: DEFAULT_KNOWLEDGE_PROFILE_V1.profileId,",
        "      version: DEFAULT_KNOWLEDGE_PROFILE_V1.version,",
        "      hash: defaultProfileHash,",
        "    });",
        "    expect(initial.contextRevisionSet.policy.revision).toBe(",
        "      contextPolicyRevisionFromProfile(",
        "        DEFAULT_KNOWLEDGE_PROFILE_V1 as unknown as Record<string, unknown>,",
        "      ),",
        "    );",
    ]
)
if test.count(old_expect) != 1:
    raise SystemExit(f"test default expectation anchor count={test.count(old_expect)}")
test = test.replace(old_expect, new_expect, 1)
test_path.write_text(test)
