#!/usr/bin/env python3
"""Fail-closed, NON-CERTIFYING audit of an unsigned technical Z ZIP against
the original private Z packet and X/Y custody. No source or reviewer text
is written to the redacted receipt or to stdout.

python scripts/s2-audit-technical-z-intake.py
  --technical-z <PRIVATE-TECHNICAL-Z.zip>
  --original-z <PRIVATE-ORIGINAL-Z.zip>
  --xy-custody <PRIVATE-XY-CUSTODY.zip>
  --output <PRIVATE-NEW-RECEIPT.json>
"""
import argparse
import collections
import csv
import io
import hashlib
import json
import pathlib
import re
import sys
import zipfile

TECH_JSON = "AKP_S2_Z_177_DECISIONES_TECNICAS_SIN_FIRMA_20261029.json"
TECH_CSV = "AKP_S2_Z_177_DECISIONES_TECNICAS_SIN_FIRMA_20261029.csv"
TECH_MD = "AKP_S2_Z_177_ACTA_TECNICA_NO_FIRMADA_20261029.md"
TECH_MANIFEST = "AKP_S2_Z_177_MANIFEST_SHA256_20261029.json"
ORIGINAL = "Z/SOURCE-ONLY-Z-disagreements.json"
XY_X = "CUSTODIO/SUBMISSION-REVIEWER-X.json"
XY_Y = "CUSTODIO/SUBMISSION-REVIEWER-Y.json"
SHA = re.compile(r"^[a-f0-9]{64}$")


def stop(reason):
    raise ValueError("S2_UNSIGNED_TECHNICAL_Z_" + reason)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def bounded_zip(path, expected, max_total=8_000_000):
    z = zipfile.ZipFile(path)
    members = z.infolist()
    if len(members) > 50 or len({m.filename for m in members}) != len(members):
        stop("ZIP_FILE_SET")
    if any(m.file_size > 4_000_000 or m.file_size < 0 or
           m.compress_size > 4_000_000 or
           not m.filename or m.filename.startswith("/") or
           ".." in pathlib.PurePosixPath(m.filename).parts for m in members):
        stop("ZIP_ENTRY_UNSAFE")
    if sum(m.file_size for m in members) > max_total:
        stop("ZIP_UNCOMPRESSED_BUDGET")
    if not expected.issubset(set(z.namelist())):
        stop("ZIP_REQUIRED_MEMBERS_MISSING")
    if z.testzip() is not None:
        stop("ZIP_CRC")
    return z


def read_json(z, name):
    return json.loads(z.read(name).decode("utf-8-sig"))


def original_span(text, start, end):
    if (not isinstance(start, int) or isinstance(start, bool) or
        not isinstance(end, int) or isinstance(end, bool) or
        start < 0 or end <= start or end > len(text.encode("utf-16-le")) // 2):
        return None
    try:
        return text.encode("utf-16-le")[start * 2 : end * 2].decode("utf-16-le")
    except UnicodeDecodeError:
        return None


def audit(technical, original, custody):
    with bounded_zip(technical, {TECH_JSON, TECH_CSV, TECH_MD, TECH_MANIFEST}) as z, \
         bounded_zip(original, {ORIGINAL}) as org, \
         bounded_zip(custody, {XY_X, XY_Y}) as xy:
        manifest = read_json(z, TECH_MANIFEST)
        expected_files = {TECH_JSON, TECH_CSV, TECH_MD}
        if {item.get("name") for item in manifest.get("items", [])} != expected_files:
            stop("MANIFEST_FILE_SET")
        for entry in manifest["items"]:
            data = z.read(entry["name"])
            if len(data) != entry.get("bytes") or digest(data) != entry.get("sha256"):
                stop("MANIFEST_DIGEST")
        judgment = read_json(z, TECH_JSON)
        tasks = read_json(org, ORIGINAL)
        submissions = {
            "X": read_json(xy, XY_X),
            "Y": read_json(xy, XY_Y),
        }
        if judgment.get("schemaVersion") != "akp.s2.reviewer-z-177-independent-source-adjudication.v1":
            stop("UNSUPPORTED_Z_SCHEMA")
        if judgment.get("sourcePacketSha256") != digest(pathlib.Path(original).read_bytes()):
            stop("SOURCE_Z_ZIP_PIN")
        if judgment.get("independentExternalHumanIdentityVerified") is not False or \
           judgment.get("rubricSignatureApplied") is not False or \
           judgment.get("reusePermissionsExternallyAccredited") is not False or \
           judgment.get("writerResultsConsulted") is not False or \
           judgment.get("reviewerXAndYAnswersConsulted") is not False:
            stop("Z_ATTESTATION_MUST_BE_EXPLICITLY_UNVERIFIED")
        cases = judgment.get("cases")
        source_tasks = tasks.get("cases")
        originals = tasks.get("sourceDocs")
        if not isinstance(cases, list) or len(cases) != 177 or \
           not isinstance(source_tasks, list) or len(source_tasks) != 177 or \
           not isinstance(originals, list) or len(originals) != 12:
            stop("COHORT_SIZE")
        by_id = {x["reviewCaseKey"]: x for x in source_tasks}
        by_source = {x["sourceKeySha256"]: x for x in originals}
        if len(by_id) != 177 or len(by_source) != 12:
            stop("ORIGINAL_DUPLICATE")
        for doc in originals:
            key = doc["sourceKeySha256"]
            src = doc["originalText"].encode("utf-8")
            if digest(src) != doc["originalSha256"]:
                stop("SOURCE_SHA_MISMATCH")
            original_name = "Z/ORIGINALES_POR_SHA/" + key + ".txt"
            if original_name not in org.namelist() or org.read(original_name) != src:
                stop("SOURCE_COPY_MISMATCH")
        if not all(len(s.get("cases", [])) == 240 for s in submissions.values()):
            stop("XY_COVERAGE_MISSING")
        reviewer = {who: {c["reviewCaseKey"]: c for c in blob["cases"]}
                    for who, blob in submissions.items()}
        if any(len(v) != 240 for v in reviewer.values()):
            stop("XY_DUPLICATE")
        labels = collections.Counter()
        xy_comparison = collections.Counter()
        unique = set()
        n_quotes = 0
        n_multi = 0
        for row in cases:
            key = row.get("reviewCaseKey")
            if key in unique or key not in by_id or key not in reviewer["X"] or key not in reviewer["Y"]:
                stop("Z_ID_OR_REVIEWER_MISMATCH")
            unique.add(key)
            task = by_id[key]
            doc = by_source.get(row.get("sourceKeySha256"))
            if not doc or any(row.get(k) != task[k] for k in
                ("question", "language", "sourceKeySha256")):
                stop("QUESTION_OR_SOURCE_CHANGED")
            if row.get("originalSha256") != doc["originalSha256"] or \
               row.get("sourceRepository") != doc["upstreamRepository"] or \
               row.get("sourceRelativePath") != doc["relativePath"]:
                stop("SOURCE_PROVENANCE_CHANGED")
            verdict = row.get("sourceAnswerability")
            support = row.get("supportingQuoteSpans")
            if verdict not in {"ANSWERABLE_EXPLICIT", "NOT_ANSWERABLE", "AMBIGUOUS"} or \
               not isinstance(support, list) or len(support) > 12:
                stop("INVALID_VERDICT_OR_QUOTES")
            labels[verdict] += 1
            if verdict == "ANSWERABLE_EXPLICIT":
                if not row.get("reviewerAnswer") or not support or \
                   row.get("wholeAuthorizedCorpusAbsenceChecked") is not False:
                    stop("POSITIVE_MISSING_EVIDENCE")
            elif verdict == "NOT_ANSWERABLE":
                if row.get("reviewerAnswer") or support or \
                   row.get("wholeAuthorizedCorpusAbsenceChecked") is not True:
                    stop("NEGATIVE_WITHOUT_CORPUS_ASSERTION")
            elif not row.get("reviewerNotes") or row.get("reviewerAnswer") or support:
                stop("AMBIGUOUS_NOT_EXPLAINED")
            if len(support) > 1:
                n_multi += 1
            seen_spans = set()
            for quote in support:
                n_quotes += 1
                start, end = quote.get("startUtf16"), quote.get("endUtf16")
                if quote.get("sourceKeySha256") != row["sourceKeySha256"] or \
                   quote.get("originalSha256") != doc["originalSha256"]:
                    stop("QUOTE_SOURCE_CHANGED")
                original_text = original_span(doc["originalText"], start, end)
                if not original_text or original_text != quote.get("quote") or \
                   len(original_text) > 8192:
                    stop("QUOTE_WRONG_UTF16_OR_SOURCE_TEXT")
                span = (start, end)
                if span in seen_spans:
                    stop("DUPLICATE_QUOTE")
                seen_spans.add(span)
            x = reviewer["X"][key]["sourceAnswerability"]
            y = reviewer["Y"][key]["sourceAnswerability"]
            if x == y:
                xy_comparison["xy_same_verdict"] += 1
                xy_comparison["z_same_as_xy"] += int(verdict == x)
                xy_comparison["z_changed_consensus"] += int(verdict != x)
            else:
                xy_comparison["xy_verdict_conflict"] += 1
                xy_comparison["z_matches_only_x"] += int(verdict == x)
                xy_comparison["z_matches_only_y"] += int(verdict == y)
                xy_comparison["z_matches_neither"] += int(verdict not in (x, y))
        if unique != set(by_id):
            stop("MISSING_Z_CASE")
        csv_data = z.read(TECH_CSV).decode("utf-8-sig")
        spreadsheet = list(csv.DictReader(io.StringIO(csv_data)))
        if len(spreadsheet) != 177 or len({v.get("reviewCaseKey") for v in spreadsheet}) != 177:
            stop("CSV_INCOMPLETE_OR_DUPLICATE")
        csv_by_id = {v["reviewCaseKey"]: v for v in spreadsheet}
        if set(csv_by_id) != unique:
            stop("CSV_CASE_ID_MISMATCH")
        for row in cases:
            cell = csv_by_id[row["reviewCaseKey"]]
            if (cell.get("idioma") != row["language"] or
                cell.get("pregunta") != row["question"] or
                cell.get("sourceKeySha256") != row["sourceKeySha256"] or
                cell.get("verdict_COPIAR_VALOR_DE_RUBRICA") != row["sourceAnswerability"] or
                (cell.get("respuesta_si_positiva") or "") != (row.get("reviewerAnswer") or "") or
                cell.get("corpus_completo_examinado_TRUE_FALSE") != "TRUE"):
                stop("CSV_JSON_DECISION_MISMATCH")
            spans = row["supportingQuoteSpans"]
            if json.loads(cell.get("citas_offsets_completos_JSON") or "null") != spans:
                stop("CSV_JSON_QUOTES_MISMATCH")
            if spans and (cell.get("cita_literal_SOURCE") != spans[0]["quote"] or
                cell.get("inicio_UTF16_si_se_conoce") != str(spans[0]["startUtf16"]) or
                cell.get("fin_UTF16_si_se_conoce") != str(spans[0]["endUtf16"])):
                stop("CSV_PRIMARY_QUOTE_MISMATCH")
        expected_labels = judgment.get("decisionCounts")
        if dict(labels) != expected_labels or judgment.get("caseCount") != 177:
            stop("Z_REPORTED_COUNTS_MISMATCH")
        # This report deliberately contains NO question, source text, reviewer answer
        # or citations. It is a NON-GATE technical intake even if all checks pass.
        return {
            "schemaVersion": "akp.s2.unsigned-technical-z-intake-audit.v1",
            "status": "SOURCE_EXACT_TECHNICAL_AI_Z_NOT_INDEPENDENT_GOLD",
            "technicalZZipSha256": digest(pathlib.Path(technical).read_bytes()),
            "originalZPacketZipSha256": digest(pathlib.Path(original).read_bytes()),
            "xyPrivateCustodyZipSha256": digest(pathlib.Path(custody).read_bytes()),
            "sourceOriginalsVerified": len(originals),
            "caseCount": len(cases),
            "verifiedCitationsUtf16": n_quotes,
            "multiQuotePositiveCases": n_multi,
            "technicalJudgmentCounts": dict(sorted(labels.items())),
            "xyVerdictComparison": dict(sorted(xy_comparison.items())),
            "externalReviewerIdentitiesVerified": False,
            "independentHumanGoldCertified": False,
            "sourceUseRightsExternallyAccredited": False,
            "wholeAuthorizedCorpusNegativeIndependentlyProven": False,
            "writerSourceClaimPrecisionMeasured": False,
            "writerFalseAdmissionRateMeasured": False,
            "releaseGateAccepted": False,
        }


def main():
    cli = argparse.ArgumentParser(description=__doc__)
    for name in ("technical-z", "original-z", "xy-custody", "output"):
        cli.add_argument("--" + name, type=pathlib.Path, required=True)
    args = cli.parse_args()
    repo = pathlib.Path(__file__).resolve().parent.parent
    inputs = [args.technical_z, args.original_z, args.xy_custody]
    for path in inputs + [args.output]:
        resolved = path.resolve()
        if resolved == repo or repo in resolved.parents:
            stop("PRIVATE_INPUT_AND_OUTPUT_MUST_BE_OUTSIDE_REPOSITORY")
    if any(not p.is_file() for p in inputs):
        stop("INPUT_NOT_FILE")
    if args.output.exists():
        stop("OUTPUT_MUST_BE_NEW")
    result = audit(*inputs)
    with args.output.open("x", encoding="utf-8") as output_file:
        output_file.write(json.dumps(result, sort_keys=True, indent=2) + "\n")
    print(json.dumps({"status": result["status"], "cases": result["caseCount"],
                      "verifiedCitationsUtf16": result["verifiedCitationsUtf16"],
                      "releaseGateAccepted": False}))


if __name__ == "__main__":
    try:
        main()
    except (OSError, KeyError, ValueError, TypeError, json.JSONDecodeError, zipfile.BadZipFile) as exc:
        print("S2_UNSIGNED_TECHNICAL_Z_AUDIT_FAILED:" +
              (str(exc) if str(exc).startswith("S2_UNSIGNED_TECHNICAL_Z_") else type(exc).__name__),
              file=sys.stderr)
        sys.exit(1)
