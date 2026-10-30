#!/usr/bin/env python3
"""Synthetic fail-closed tests for S2 private third-party Z reconciliation."""
import csv
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from zipfile import ZipFile

FILE = Path(__file__).with_name("s2-reconcile-owner-attested-z.py")
spec = importlib.util.spec_from_file_location("owner_attested_z", FILE)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


def h(s):
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


def fixture():
    docs = []
    for j in range(12):
        source = f"Fixture alpha {j}: exact example."
        docs.append({"sourceKeySha256": h(f"key-{j}"),
                     "originalSha256": h(source), "originalText": source,
                     "upstreamRepository": "synthetic/example",
                     "revision40Hex": "f" * 40, "relativePath": f"{j}.md",
                     "authorizedVaultScope": "test-only"})
    coord = []
    tasks = []
    z_rows = []
    x = []
    y = []
    for i in range(240):
        doc = docs[i % 12]
        key = f"{i:064x}"
        src = doc["originalText"]
        quote = src[:13]
        start = 0
        end = len(quote.encode("utf-16-le")) // 2
        support = [{"sourceKeySha256": doc["sourceKeySha256"],
                    "startUtf16": start, "endUtf16": end, "exactText": quote}]
        v_x = "ANSWERABLE_EXPLICIT"
        v_y = "ANSWERABLE_EXPLICIT"
        if 156 <= i < 177:
            v_x, v_y = "NOT_ANSWERABLE", "ANSWERABLE_EXPLICIT"
        x.append({"reviewCaseKey": key, "sourceAnswerability": v_x,
                  "reviewerAnswer": src if v_x == "ANSWERABLE_EXPLICIT" else "",
                  "supportingQuoteSpans": support if v_x == "ANSWERABLE_EXPLICIT" else [],
                  "wholeAuthorizedCorpusAbsenceChecked": v_x == "NOT_ANSWERABLE",
                  "reviewerNotes": ""})
        y.append({"reviewCaseKey": key, "sourceAnswerability": v_y,
                  "reviewerAnswer": src, "supportingQuoteSpans": support,
                  "wholeAuthorizedCorpusAbsenceChecked": False, "reviewerNotes": ""})
        coord.append({"reviewCaseKey": key, "caseSeat": f"S-{i:03d}",
                      "sourceKeySha256": doc["sourceKeySha256"],
                      "originalSha256": doc["originalSha256"], "language": "en"})
        if i < 177:
            tasks.append({"reviewCaseKey": key, "language": "en",
                          "question": f"Question {i}", "sourceKeySha256": doc["sourceKeySha256"]})
            if i in (0, 1, 2) or i in (173, 174, 175, 176):
                v = "AMBIGUOUS"
            elif 156 <= i < 173:
                v = "ANSWERABLE_EXPLICIT" if i < 170 else "NOT_ANSWERABLE"
            else:
                v = "ANSWERABLE_EXPLICIT"
            z_rows.append({
                "reviewCaseKey": key, "idioma": "en", "pregunta": f"Question {i}",
                "sourceKeySha256": doc["sourceKeySha256"],
                "verdict_COPIAR_VALOR_DE_RUBRICA": v,
                "respuesta_si_positiva": src if v == "ANSWERABLE_EXPLICIT" else "",
                "cita_literal_SOURCE": quote if v == "ANSWERABLE_EXPLICIT" else "",
                "inicio_UTF16_si_se_conoce": str(start) if v == "ANSWERABLE_EXPLICIT" else "",
                "fin_UTF16_si_se_conoce": str(end) if v == "ANSWERABLE_EXPLICIT" else "",
                "corpus_completo_examinado_TRUE_FALSE": "TRUE",
                "notas_revisor": "Insufficient evidence" if v == "AMBIGUOUS" else "",
            })
    out = io.StringIO(newline="")
    w = csv.DictWriter(out, fieldnames=mod.EXPECTED_FIELDS, lineterminator="\n")
    w.writeheader()
    w.writerows(z_rows)
    return docs, coord, tasks, x, y, out.getvalue().encode("utf-8"), z_rows


class ReconcileTests(unittest.TestCase):
    def setUp(self):
        self.work = tempfile.TemporaryDirectory()
        self.root = Path(self.work.name)
        docs, coord, tasks, x, y, payload, rows = fixture()
        self.docs, self.coord, self.tasks, self.x, self.y, self.payload, self.rows = (
            docs, coord, tasks, x, y, payload, rows)
        self.paths = [self.root / name for name in ("source.zip", "xy.zip", "coordinator.zip")]
        with ZipFile(self.paths[0], "w") as z:
            z.writestr(mod.ORIGINAL_PATH, json.dumps({"sourceDocs": docs, "cases": tasks}))
            for doc in docs:
                z.writestr("Z/ORIGINALES_POR_SHA/" + doc["sourceKeySha256"] + ".txt",
                           doc["originalText"].encode("utf-8"))
        with ZipFile(self.paths[1], "w") as z:
            for who, records in (("X", x), ("Y", y)):
                z.writestr(f"CUSTODIO/SUBMISSION-REVIEWER-{who}.json",
                           json.dumps({"cases": records}))
        with ZipFile(self.paths[2], "w") as z:
            z.writestr(mod.COORDINATOR_PATH, json.dumps({"cases": coord}))
    def tearDown(self):
        self.work.cleanup()
    def audit(self, payload=None, canonical=None):
        with ZipFile(self.paths[0]) as original, ZipFile(self.paths[1]) as xy, ZipFile(self.paths[2]) as coord:
            return mod.reconcile(self.payload if payload is None else payload,
                                 original, xy, coord,
                                 mod.canon(self.rows) if canonical is None else canonical)
    def test_entire_synthetic_cohort_and_seven_exceptions(self):
        cases, counts, comparison, flags = self.audit()
        self.assertEqual(len(cases), 240)
        self.assertEqual(comparison["xy_identical_uncontested"], 63)
        self.assertEqual(len(flags), 7)
        self.assertEqual(sum(counts.values()), 240)
        self.assertEqual(comparison["z_overrides_consensus"], 3)
        self.assertEqual(comparison["z_matches_neither"], 4)
    def test_changed_content_rejected_even_when_ids_present(self):
        changed = self.payload.replace(b"Question 12", b"Question 13", 1)
        with self.assertRaisesRegex(ValueError, "CANONICAL_SHA"):
            self.audit(changed)
    def test_mutated_canonical_pin_rejected(self):
        with self.assertRaisesRegex(ValueError, "CANONICAL_SHA"):
            self.audit(canonical="0" * 64)
    def test_bad_offset_rejected_when_re_pinned(self):
        rows = [dict(r) for r in self.rows]
        rows[3]["fin_UTF16_si_se_conoce"] = "12"
        buf = io.StringIO(newline="")
        w = csv.DictWriter(buf, fieldnames=mod.EXPECTED_FIELDS, lineterminator="\n")
        w.writeheader()
        w.writerows(rows)
        with self.assertRaisesRegex(ValueError, "Z_QUOTE_WRONG_ORIGINAL"):
            self.audit(buf.getvalue().encode(), canonical=mod.canon(rows))
    def test_unadjudicated_xy_disagreement_fails(self):
        with ZipFile(self.paths[1], "w") as z:
            altered = [dict(r) for r in self.y]
            altered[239]["sourceAnswerability"] = "NOT_ANSWERABLE"
            for who, records in (("X", self.x), ("Y", altered)):
                z.writestr(f"CUSTODIO/SUBMISSION-REVIEWER-{who}.json",
                           json.dumps({"cases": records}))
        with self.assertRaisesRegex(ValueError, "UNADJUDICATED_XY_DISAGREEMENT"):
            self.audit()
    def test_source_sha_corruption_is_not_accepted(self):
        with ZipFile(self.paths[0], "w") as z:
            altered = [dict(d) for d in self.docs]
            altered[0]["originalSha256"] = "0" * 64
            z.writestr(mod.ORIGINAL_PATH, json.dumps({"sourceDocs": altered, "cases": self.tasks}))
            for doc in self.docs:
                z.writestr("Z/ORIGINALES_POR_SHA/" + doc["sourceKeySha256"] + ".txt",
                           doc["originalText"].encode())
        with self.assertRaisesRegex(ValueError, "ORIGINAL_SHA"):
            self.audit()
    def test_utf16_surrogate_pair_and_bad_splits(self):
        text = "X\U0001F600Y"
        self.assertEqual(mod.utf16_span(text, 1, 3), "\U0001F600")
        with self.assertRaisesRegex(ValueError, "UTF16_SURROGATE"):
            mod.utf16_span(text, 1, 2)


if __name__ == "__main__":
    unittest.main()
