from pathlib import Path

path = Path("apps/api/test/principal-auth.integration.test.ts")
text = path.read_text()
old = '''      payload: { label: "Compiler worker" },
'''
new = '''      payload: {
        label: "Compiler worker",
        allowedActions: [
          "workspace:read",
          "workspace:claim",
          "workspace:handoff",
          "workspace:event:append",
          "knowledge:read",
          "knowledge:propose",
        ],
      },
'''
if text.count(old) != 1:
    raise SystemExit(f"principal issuance payload anchor changed:{text.count(old)}")
path.write_text(text.replace(old, new, 1))
