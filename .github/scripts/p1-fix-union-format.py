from pathlib import Path

path = Path("apps/api/src/routes/reviews.ts")
text = path.read_text()
old = '''  permission:\n    | "knowledge:read"\n    | "knowledge:propose"\n    | "knowledge:review"\n    | "admin",'''
new = '''  permission:\n    "knowledge:read" | "knowledge:propose" | "knowledge:review" | "admin",'''
count = text.count(old)
if count != 2:
    raise SystemExit(f"expected 2 expanded permission unions, found {count}")
path.write_text(text.replace(old, new))
