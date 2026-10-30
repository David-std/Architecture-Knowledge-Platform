"""Regression controls for fail-closed technical Z SOURCE audit (synthetic only)."""
import csv
import hashlib
import importlib.util
import io
import json
import pathlib
import tempfile
import unittest
import zipfile

SCRIPT = pathlib.Path(__file__).with_name("s2-audit-technical-z-intake.py")
spec = importlib.util.spec_from_file_location("s2_technical_z_intake", SCRIPT)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
sha = lambda x: hashlib.sha256(x if isinstance(x, bytes) else x.encode()).hexdigest()
blob = lambda x: json.dumps(x, ensure_ascii=False).encode("utf8")
CSV_FIELDS = [
    "reviewCaseKey", "idioma", "pregunta", "sourceKeySha256",
    "verdict_COPIAR_VALOR_DE_RUBRICA", "respuesta_si_positiva",
    "cita_literal_SOURCE", "inicio_UTF16_si_se_conoce", "fin_UTF16_si_se_conoce",
    "corpus_completo_examinado_TRUE_FALSE", "notas_revisor", "citas_offsets_completos_JSON",
]


def fixture():
    sources = []
    for j in range(12):
        text = f"Authority 🔥 of source {j} confirms approved outcome after an independently reviewed period."
        sources.append({
            "sourceKeySha256": sha(f"source-id-{j}"),
            "originalSha256": sha(text),
            "originalText": text,
            "upstreamRepository": f"publisher{j}/repo",
            "revision40Hex": "a" * 40,
            "relativePath": "docs/source.txt",
            "authorizedVaultScope": f"public-candidate-only-F{j:02d}-NOT_EXTERNALLY_AUTHORIZED",
        })
    tasks = []
    cases = []
    x = []
    y = []
    for i in range(177):
        doc = sources[i % 12]
        key = sha(f"case-{i}")
        task = {
            "reviewCaseKey": key, "question": f"What does source {i%12} confirm in case {i}?",
            "language": "en" if i % 2 else "es",
            "sourceKeySha256": doc["sourceKeySha256"],
            "sourceAnswerability": None, "reviewerAnswer": None,
            "supportingQuoteSpans": [], "wholeAuthorizedCorpusAbsenceChecked": None,
            "reviewerNotes": None,
        }
        tasks.append(task)
        if i == 0:
            label = "NOT_ANSWERABLE"
            quotes = []
            answer = ""
        elif i < 9:
            label = "AMBIGUOUS"
            quotes = []
            answer = ""
        else:
            label = "ANSWERABLE_EXPLICIT"
            quote = doc["originalText"][:25]
            quotes = [{
                "sourceKeySha256": doc["sourceKeySha256"],
                "originalSha256": doc["originalSha256"],
                "startUtf16": 0, "endUtf16": len(quote.encode("utf-16-le")) // 2, "quote": quote,
            }]
            answer = f"Source {i%12} confirms the approved outcome."
        cases.append({
            "caseNumber": i+1, "reviewCaseKey": key, "question": task["question"],
            "language": task["language"], "sourceKeySha256": doc["sourceKeySha256"],
            "originalSha256": doc["originalSha256"], "sourceRepository": doc["upstreamRepository"],
            "sourceRelativePath": doc["relativePath"], "sourceAnswerability": label,
            "reviewerAnswer": answer, "supportingQuoteSpans": quotes,
            "wholeAuthorizedCorpusAbsenceChecked": label == "NOT_ANSWERABLE",
            "reviewerNotes": "Synthetic reviewer explanation" if label != "ANSWERABLE_EXPLICIT" else "",
        })
        for bucket in (x, y):
            bucket.append({"reviewCaseKey": key, "sourceAnswerability": "ANSWERABLE_EXPLICIT"})
    for i in range(177, 240):
        for bucket in (x, y):
            bucket.append({"reviewCaseKey": sha(f"unused-case-{i}"),
                          "sourceAnswerability": "ANSWERABLE_EXPLICIT"})
    original = {"cases": tasks, "sourceDocs": sources}
    tech = {
        "schemaVersion": "akp.s2.reviewer-z-177-independent-source-adjudication.v1",
        "sourcePacketSha256": None,
        "independentExternalHumanIdentityVerified": False,
        "rubricSignatureApplied": False,
        "reusePermissionsExternallyAccredited": False,
        "writerResultsConsulted": False,
        "reviewerXAndYAnswersConsulted": False,
        "caseCount": 177,
        "decisionCounts": {"ANSWERABLE_EXPLICIT": 168, "AMBIGUOUS": 8, "NOT_ANSWERABLE": 1},
        "cases": cases,
    }
    return original, tech, x, y


def write_fixtures(root, modify=None):
    original, technical, x, y = fixture()
    if modify:
        modify(original, technical, x, y)
    pack = root/"source.zip"
    with zipfile.ZipFile(pack, "w") as z:
        z.writestr(module.ORIGINAL, blob(original))
        for s in original["sourceDocs"]:
            z.writestr("Z/ORIGINALES_POR_SHA/" + s["sourceKeySha256"] + ".txt",
                       s["originalText"].encode())
    technical["sourcePacketSha256"] = sha(pack.read_bytes())
    csv_buf = io.StringIO(newline="")
    wr = csv.DictWriter(csv_buf, fieldnames=CSV_FIELDS)
    wr.writeheader()
    for row in technical["cases"]:
        spans = row["supportingQuoteSpans"]
        wr.writerow({
            "reviewCaseKey": row["reviewCaseKey"], "idioma": row["language"],
            "pregunta": row["question"], "sourceKeySha256": row["sourceKeySha256"],
            "verdict_COPIAR_VALOR_DE_RUBRICA": row["sourceAnswerability"],
            "respuesta_si_positiva": row["reviewerAnswer"],
            "cita_literal_SOURCE": spans[0]["quote"] if spans else "",
            "inicio_UTF16_si_se_conoce": spans[0]["startUtf16"] if spans else "",
            "fin_UTF16_si_se_conoce": spans[0]["endUtf16"] if spans else "",
            "corpus_completo_examinado_TRUE_FALSE": "TRUE",
            "notas_revisor": row["reviewerNotes"],
            "citas_offsets_completos_JSON": json.dumps(spans),
        })
    files = {
        module.TECH_JSON: blob(technical),
        module.TECH_CSV: csv_buf.getvalue().encode(),
        module.TECH_MD: b"# Synthetic Z no human signature\n",
    }
    manifest = {"items": [
        {"name": n, "bytes": len(b), "sha256": sha(b)} for n, b in files.items()
    ]}
    tech = root/"technical.zip"
    with zipfile.ZipFile(tech, "w") as z:
        for n, b in files.items():
            z.writestr(n, b)
        z.writestr(module.TECH_MANIFEST, blob(manifest))
    custody = root/"custody.zip"
    with zipfile.ZipFile(custody, "w") as z:
        z.writestr(module.XY_X, blob({"cases": x}))
        z.writestr(module.XY_Y, blob({"cases": y}))
    return tech, pack, custody


class TestUnsignedTechnicalZIntake(unittest.TestCase):
    def run_case(self, modify=None):
        with tempfile.TemporaryDirectory(prefix="akp-s2-z-") as td:
            return module.audit(*write_fixtures(pathlib.Path(td), modify))

    def assert_rejected(self, modify, code):
        with self.assertRaisesRegex(ValueError, code):
            self.run_case(modify)

    def test_full_177_case_synthetic_reference_is_never_release_gold(self):
        r = self.run_case()
        self.assertEqual(r["caseCount"], 177)
        self.assertEqual(r["sourceOriginalsVerified"], 12)
        self.assertEqual(r["verifiedCitationsUtf16"], 168)
        self.assertEqual(r["technicalJudgmentCounts"]["AMBIGUOUS"], 8)
        self.assertFalse(r["independentHumanGoldCertified"])
        self.assertFalse(r["releaseGateAccepted"])

    def test_tampered_quote_exact_utf16_rejected(self):
        def modify(src, tech, x, y):
            tech["cases"][9]["supportingQuoteSpans"][0]["quote"] = "fraud"
        self.assert_rejected(modify, "QUOTE_WRONG_UTF16_OR_SOURCE_TEXT")

    def test_changed_question_rejected(self):
        def modify(src, tech, x, y):
            tech["cases"][6]["question"] = "An altogether different question?"
        self.assert_rejected(modify, "QUESTION_OR_SOURCE_CHANGED")

    def test_duplicate_case_rejected(self):
        def modify(src, tech, x, y):
            tech["cases"][10] = dict(tech["cases"][11])
        self.assert_rejected(modify, "Z_ID_OR_REVIEWER_MISMATCH")

    def test_signed_or_invented_identity_is_not_accepted(self):
        def modify(src, tech, x, y):
            tech["independentExternalHumanIdentityVerified"] = True
        self.assert_rejected(modify, "Z_ATTESTATION_MUST_BE_EXPLICITLY_UNVERIFIED")

    def test_missing_positive_quote_rejected(self):
        def modify(src, tech, x, y):
            tech["cases"][10]["supportingQuoteSpans"] = []
        self.assert_rejected(modify, "POSITIVE_MISSING_EVIDENCE")

    def test_split_utf16_surrogate_rejected(self):
        def modify(src, tech, x, y):
            tech["cases"][10]["supportingQuoteSpans"][0]["startUtf16"] = 11
        self.assert_rejected(modify, "QUOTE_WRONG_UTF16_OR_SOURCE_TEXT")

    def test_dishonest_negative_whole_corpus_claim_rejected(self):
        def modify(src, tech, x, y):
            tech["cases"][0]["wholeAuthorizedCorpusAbsenceChecked"] = False
        self.assert_rejected(modify, "NEGATIVE_WITHOUT_CORPUS_ASSERTION")


if __name__ == "__main__":
    unittest.main()
