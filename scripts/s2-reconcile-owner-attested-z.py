#!/usr/bin/env python3
"""Reconcile real third-party Z source-only CSV with frozen X/Y DEV cases.

Output is PRIVATE DEV reference only. Owner-attested blinding is not an
externally verified identity, independent prospective gold, or release proof.
Never put --out under Git. The script does not modify an input or an original.
"""
import argparse
import collections
import csv
import hashlib
import io
import json
import pathlib
import zipfile

EXPECTED_FIELDS = (
    "reviewCaseKey", "idioma", "pregunta", "sourceKeySha256",
    "verdict_COPIAR_VALOR_DE_RUBRICA", "respuesta_si_positiva",
    "cita_literal_SOURCE", "inicio_UTF16_si_se_conoce",
    "fin_UTF16_si_se_conoce", "corpus_completo_examinado_TRUE_FALSE",
    "notas_revisor",
)
VERDICTS = {"ANSWERABLE_EXPLICIT", "NOT_ANSWERABLE", "AMBIGUOUS", "CONTRADICTED"}
ORIGINAL_PATH = "Z/SOURCE-ONLY-Z-disagreements.json"
ORIGINAL_CSV_PATH = "Z/RESPUESTAS_PARA_RELLENAR_Z_177.csv"
COORDINATOR_PATH = "00_CUSTODIA_PRIVADA_NO_ENTREGAR/COORDINATOR-ONLY-NOT-FOR-REVIEWERS.json"


def fail(message):
    raise ValueError("S2_Z_RECONCILIATION_" + message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def canon(rows):
    return digest(json.dumps(rows, ensure_ascii=False, sort_keys=True,
                             separators=(",", ":")).encode("utf-8"))


def read_csv(data):
    text = data.decode("utf-8-sig", errors="strict")
    r = csv.DictReader(io.StringIO(text, newline=""))
    if tuple(r.fieldnames or ()) != EXPECTED_FIELDS:
        fail("CSV_SCHEMA")
    rows = list(r)
    if any(None in row or not all(isinstance(v, str) for v in row.values()) for row in rows):
        fail("CSV_MALFORMED")
    return rows


def read_json(z, name):
    return json.loads(z.read(name).decode("utf-8"))


def utf16_span(text, start, end):
    source = text.encode("utf-16-le")
    if start < 0 or end <= start or end * 2 > len(source):
        fail("UTF16_RANGE")
    try:
        return source[2 * start:2 * end].decode("utf-16-le")
    except UnicodeDecodeError:
        fail("UTF16_SURROGATE")


def verify_quotes(row, source):
    normalized = []
    for span in row.get("supportingQuoteSpans", []):
        if span.get("sourceKeySha256") != row["sourceKeySha256"]:
            fail("QUOTE_SOURCE_KEY")
        quote = span.get("exactText")
        if not isinstance(quote, str) or not quote:
            fail("QUOTE_MISSING_EXACT_TEXT")
        if utf16_span(source, span["startUtf16"], span["endUtf16"]) != quote:
            fail("QUOTE_NOT_SOURCE_EXACT")
        normalized.append({
            "sourceKeySha256": row["sourceKeySha256"],
            "originalSha256": row["originalSha256"],
            "startUtf16": span["startUtf16"],
            "endUtf16": span["endUtf16"],
            "quote": quote,
        })
    return normalized


def reconcile(submission, original, xy, coordinator, expected_canonical):
    z_rows = read_csv(submission)
    if len(z_rows) != 177 or canon(z_rows) != expected_canonical:
        fail("SUBMISSION_ROWS_OR_CANONICAL_SHA")
    tasks = read_json(original, ORIGINAL_PATH)
    coordinator_rows = read_json(coordinator, COORDINATOR_PATH)["cases"]
    x = read_json(xy, "CUSTODIO/SUBMISSION-REVIEWER-X.json")["cases"]
    y = read_json(xy, "CUSTODIO/SUBMISSION-REVIEWER-Y.json")["cases"]
    docs = tasks["sourceDocs"]
    if not (len(docs) == 12 and len(tasks["cases"]) == 177 and
            len(coordinator_rows) == len(x) == len(y) == 240):
        fail("COHORT_LENGTH")
    by_source = {doc["sourceKeySha256"]: doc for doc in docs}
    c_map = {row["reviewCaseKey"]: row for row in coordinator_rows}
    t_map = {row["reviewCaseKey"]: row for row in tasks["cases"]}
    x_map = {row["reviewCaseKey"]: row for row in x}
    y_map = {row["reviewCaseKey"]: row for row in y}
    z_map = {row["reviewCaseKey"]: row for row in z_rows}
    if (len(by_source) != 12 or len(c_map) != 240 or len(t_map) != 177 or
        len(x_map) != 240 or len(y_map) != 240 or len(z_map) != 177 or
        set(x_map) != set(c_map) or set(y_map) != set(c_map) or
        set(z_map) != set(t_map) or not set(t_map).issubset(c_map)):
        fail("CASE_ID_COVERAGE")
    for doc in docs:
        b = doc["originalText"].encode("utf-8")
        k = doc["sourceKeySha256"]
        if digest(b) != doc["originalSha256"]:
            fail("ORIGINAL_SHA")
        if original.read("Z/ORIGINALES_POR_SHA/" + k + ".txt") != b:
            fail("ORIGINAL_COPY")
    categories = collections.Counter()
    comparisons = collections.Counter()
    flagged = []
    cases = []
    for case in coordinator_rows:
        k = case["reviewCaseKey"]
        sx, sy = x_map[k], y_map[k]
        source_key = case["sourceKeySha256"]
        doc = by_source.get(source_key)
        if not doc or case["originalSha256"] != doc["originalSha256"]:
            fail("COORDINATOR_ORIGINAL_PROVENANCE")
        if k in z_map:
            row, task = z_map[k], t_map[k]
            if (row["sourceKeySha256"] != task["sourceKeySha256"] or
                row["sourceKeySha256"] != source_key or
                row["idioma"] != task["language"] or
                row["pregunta"] != task["question"]):
                fail("Z_QUESTION_CHANGED")
            v = row["verdict_COPIAR_VALOR_DE_RUBRICA"].strip()
            answer = row["respuesta_si_positiva"]
            quote = row["cita_literal_SOURCE"]
            notes = row["notas_revisor"]
            if v not in VERDICTS or row["corpus_completo_examinado_TRUE_FALSE"].upper() != "TRUE":
                fail("VERDICT_OR_CORPUS_FLAG")
            if v == "ANSWERABLE_EXPLICIT" and (not answer.strip() or not quote):
                fail("POSITIVE_INCOMPLETE")
            if v == "NOT_ANSWERABLE" and (answer.strip() or quote):
                fail("NEGATIVE_NOT_WITHHELD")
            if v in ("AMBIGUOUS", "CONTRADICTED") and not notes.strip():
                fail("UNCERTAIN_MISSING_REASON")
            spans = []
            if quote:
                try:
                    a, b = int(row["inicio_UTF16_si_se_conoce"]), int(row["fin_UTF16_si_se_conoce"])
                except (ValueError, TypeError):
                    fail("QUOTE_OFFSETS_MISSING")
                if utf16_span(doc["originalText"], a, b) != quote:
                    fail("Z_QUOTE_WRONG_ORIGINAL")
                spans = [{"sourceKeySha256": source_key,
                          "originalSha256": doc["originalSha256"],
                          "startUtf16": a, "endUtf16": b, "quote": quote}]
            elif row["inicio_UTF16_si_se_conoce"] or row["fin_UTF16_si_se_conoce"]:
                fail("OFFSETS_WITHOUT_QUOTE")
            if sx["sourceAnswerability"] == sy["sourceAnswerability"]:
                comparisons["xy_same_verdict"] += 1
                if v == sx["sourceAnswerability"]:
                    comparisons["z_matches_xy"] += 1
                else:
                    comparisons["z_overrides_consensus"] += 1
                    flagged.append({"caseKeyPrefix": k[:16], "kind": "Z_OVERRIDES_XY"})
            else:
                comparisons["xy_different_verdict"] += 1
                if v == sx["sourceAnswerability"]:
                    comparisons["z_matches_only_x"] += 1
                elif v == sy["sourceAnswerability"]:
                    comparisons["z_matches_only_y"] += 1
                else:
                    comparisons["z_matches_neither"] += 1
                    flagged.append({"caseKeyPrefix": k[:16], "kind": "Z_NEW_VERDICT"})
            origin = "Z_THIRD_PARTY_OWNER_ATTESTED"
            absence_declared = v == "NOT_ANSWERABLE"
        else:
            fields = ("sourceAnswerability", "reviewerAnswer",
                      "supportingQuoteSpans", "wholeAuthorizedCorpusAbsenceChecked")
            if any(sx[f] != sy[f] for f in fields):
                fail("UNADJUDICATED_XY_DISAGREEMENT")
            v = sx["sourceAnswerability"]
            answer = sx["reviewerAnswer"] or ""
            spans = verify_quotes(
                dict(sx, originalSha256=doc["originalSha256"],
                     sourceKeySha256=source_key), doc["originalText"])
            notes = sx.get("reviewerNotes", "") or ""
            if v not in VERDICTS:
                fail("CONSENSUS_VERDICT")
            origin = "XY_EXACT_CONSENSUS"
            absence_declared = bool(sx["wholeAuthorizedCorpusAbsenceChecked"])
            comparisons["xy_identical_uncontested"] += 1
        categories[v] += 1
        cases.append({
            "reviewCaseKey": k,
            "caseSeat": case["caseSeat"],
            "sourceKeySha256": source_key,
            "originalSha256": doc["originalSha256"],
            "language": case["language"],
            "sourceAnswerability": v,
            "reviewerAnswer": answer,
            "supportingQuoteSpans": spans,
            "wholeAuthorizedCorpusAbsenceCheckedDeclared": absence_declared,
            "reviewerNotes": notes,
            "decisionProvenance": origin,
        })
    if len(flagged) != 7 or comparisons["xy_identical_uncontested"] != 63:
        fail("UNEXPECTED_REVIEW_RECONCILIATION")
    return cases, dict(sorted(categories.items())), dict(sorted(comparisons.items())), flagged


def main():
    p = argparse.ArgumentParser(description=__doc__)
    for name in ("submission", "original-z", "xy-custody", "coordinator", "output"):
        p.add_argument("--" + name, required=True, type=pathlib.Path)
    p.add_argument("--expected-canonical-sha256", required=True)
    p.add_argument("--original-upload-sha256", required=True)
    p.add_argument("--owner-attested-z-blindness", action="store_true")
    args = p.parse_args()
    if not args.owner_attested_z_blindness:
        fail("OWNER_ATTESTATION_NOT_GIVEN")
    if any(len(pin) != 64 or any(c not in "0123456789abcdef" for c in pin)
           for pin in (args.expected_canonical_sha256, args.original_upload_sha256)):
        fail("INVALID_SOURCE_PIN")
    names = ("submission", "original_z", "xy_custody", "coordinator")
    paths = [getattr(args, name).resolve() for name in names]
    dest = args.output.resolve()
    if dest.exists() or dest in paths or dest.suffix != ".zip":
        fail("OUTPUT_UNSAFE_OR_ALREADY_EXISTS")
    if any(len(getattr(args, name).read_bytes()) > 8_000_000 for name in names):
        fail("INPUT_TOO_LARGE")
    with zipfile.ZipFile(args.original_z) as orig, \
         zipfile.ZipFile(args.xy_custody) as xy, \
         zipfile.ZipFile(args.coordinator) as coord:
        for z in (orig, xy, coord):
            entries = z.infolist()
            if (len(entries) > 100 or
                sum(e.file_size for e in entries) > 8_000_000 or
                any(e.file_size > 4_000_000 for e in entries) or
                len({e.filename for e in entries}) != len(entries)):
                fail("ZIP_EXPANSION_OR_DUPLICATE")
        if any(z.testzip() is not None for z in (orig, xy, coord)):
            fail("ZIP_CRC")
        cases, counts, comparisons, flagged = reconcile(
            args.submission.read_bytes(), orig, xy, coord,
            args.expected_canonical_sha256)
    evidence = {
        "schemaVersion": "akp.s2.owner-attested-z-dev-reconciliation.v1",
        "status": "DEV_REFERENCE_RECONCILED_NOT_INDEPENDENT_RELEASE_GOLD",
        "caseCount": 240, "zCases": 177, "xyExactConsensusCases": 63,
        "decisionCounts": counts, "xyComparison": comparisons,
        "zBlindnessAndNoXYParticipationAttestedByOwner": True,
        "ownerAttestationIsExternalIdentityVerification": False,
        "independentReviewerIdentityExternallyVerified": False,
        "provenIndependentSourceFamilySelection": False,
        "sourceUseRightsExternallyAccredited": False,
        "negativeWholeCorpusVerificationExternallyProven": False,
        "writerClaimCorrectnessMeasured": False,
        "pairedDeterministicCandidateManualEvaluationDone": False,
        "independentProspectiveHoldout": False,
        "releaseGateAccepted": False,
        "originalUserUploadSha256": args.original_upload_sha256,
        "transferredContentSha256": digest(args.submission.read_bytes()),
        "canonicalSubmissionRowsSha256": args.expected_canonical_sha256,
        "originalZZipSha256": digest(args.original_z.read_bytes()),
        "xyCustodyZipSha256": digest(args.xy_custody.read_bytes()),
        "coordinatorZipSha256": digest(args.coordinator.read_bytes()),
        "exceptionCount": len(flagged),
    }
    reference = {"schemaVersion": "akp.s2.private-dev-source-reference.v1",
                 "status": evidence["status"], "cases": cases,
                 "releaseGateAccepted": False}
    with zipfile.ZipFile(dest, "x", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        z.writestr("PRIVATE-DEV-SOURCE-REFERENCE-240.json",
                   json.dumps(reference, ensure_ascii=False, indent=2) + "\n")
        z.writestr("REDACTED-RECONCILIATION-RECEIPT.json",
                   json.dumps(evidence, ensure_ascii=False, indent=2) + "\n")
        z.writestr("PRIVATE-Z-EXCEPTIONS-7.json",
                   json.dumps(flagged, ensure_ascii=False, indent=2) + "\n")
        z.writestr("READ-ME.txt", "Private owner-attested DEV 240-case source reference; do not publish, redistribute or accept as independent release gold.\n")
    print(json.dumps({"output": str(dest), "zipSha256": digest(dest.read_bytes()),
                      "z": 177, "xy": 63, "counts": counts,
                      "comparisons": comparisons, "exceptionCount": len(flagged),
                      "releaseGateAccepted": False}, ensure_ascii=False))


if __name__ == "__main__":
    main()
