#!/usr/bin/env python3
"""Prepare a VERSIONED PRIVATE owner-approved DEV candidate revision of §104.
Not an external holdout freeze, and never a source of authenticated human gold.

python scripts/s2-prepare-owner-editorial-revision.py --proposal C:/private/adj.csv
 --proposal-sha256 <existing SHA> --packet-x C:/private/X.json
 --packet-x-pin C:/private/X.sha256 --packet-y C:/private/Y.json
 --packet-y-pin C:/private/Y.sha256 --output-dir C:/private/NEW-UNIQUE
"""
import argparse
import copy
import csv
import hashlib
import io
import json
import pathlib
import re
import sys

EXPECTED_ORIGINAL_CASES = 9
EXPECTED_REWORD = 8
EXPECTED_RETAIN = 1
SHA64 = re.compile(r"^[a-f0-9]{64}$")
CASE_NUMBERS = {"2", "13", "19", "39", "72", "100", "134", "138", "147"}


def abort(reason):
    raise ValueError("S2_OWNER_EDIT_" + reason)


def sha(value):
    return hashlib.sha256(value).hexdigest()


def strict_boolean(value):
    return value in ("True", "False")


def validate(original_bytes, expected_sha, role):
    if not SHA64.fullmatch(expected_sha) or sha(original_bytes) != expected_sha:
        abort("PACKET_PIN_INVALID_" + role)
    try:
        packet = json.loads(original_bytes.decode("utf-8-sig"))
    except (ValueError, UnicodeDecodeError):
        abort("PACKET_ENCODING_INVALID_" + role)
    if (packet.get("schemaVersion") != "akp.s2.preinference-original-source-review.v1"
        or packet.get("reviewer") != role or packet.get("releaseGateAccepted") is not False
        or packet.get("independentGoldAdjudicated") is not False
        or len(packet.get("cases", [])) != 240 or len(packet.get("sourceDocs", [])) != 12):
        abort("ORIGINAL_PACKET_STRUCTURE_" + role)
    cases = {case["reviewCaseKey"]: case for case in packet["cases"]}
    sources = {source["sourceKeySha256"]: source for source in packet["sourceDocs"]}
    if len(cases) != 240 or len(sources) != 12:
        abort("ORIGINAL_DUPLICATED_CASES_OR_SOURCES")
    if any(sha(doc["originalText"].encode("utf-8")) != doc["originalSha256"]
           for doc in sources.values()):
        abort("ORIGINAL_SOURCE_BYTES_CHANGED")
    if any(case.get("sourceAnswerability") is not None or
           case.get("reviewerAnswer") is not None or
           case.get("supportingQuoteSpans") != [] for case in cases.values()):
        abort("EXPECTED_BLANK_ORIGINAL_REVIEW")
    return packet, cases, sources


def make_revision(proposal_bytes, proposal_pin, x_bytes, x_pin, y_bytes, y_pin):
    if sha(proposal_bytes) != proposal_pin or not SHA64.fullmatch(proposal_pin):
        abort("PROPOSAL_PIN_INVALID")
    try:
        raw = proposal_bytes.decode("utf-8-sig")
        reader = csv.DictReader(io.StringIO(raw))
        rows = list(reader)
    except (UnicodeDecodeError, csv.Error):
        abort("PROPOSAL_CSV_INVALID")
    if len(rows) != 9 or {row.get("caseNumber") for row in rows} != CASE_NUMBERS:
        abort("EXPECTED_NINE_EXACT_ORIGINAL_CASES")
    x, xc, xs = validate(x_bytes, x_pin, "X")
    y, yc, ys = validate(y_bytes, y_pin, "Y")
    if set(xc) != set(yc) or set(xs) != set(ys):
        abort("XY_ORIGINAL_CASE_SET_DIFFERENCE")
    if any(xc[key] != yc[key] for key in xc):
        abort("XY_QUESTION_OR_SCOPE_CHANGED")
    if any(xs[key] != ys[key] for key in xs):
        abort("XY_ORIGINAL_SOURCE_CHANGED")
    new_keys = set(xc)
    replacements = []
    approvals = []
    for row in rows:
        required = [
            "caseNumber", "originalReviewCaseKey", "language",
            "originalQuestion", "sourceRepository", "originalSha256",
            "technicalAdjudication", "proposedAnswerability", "replacementQuestionProposal",
            "replacementCaseKeySha256", "utf16QuoteSpansJson",
            "ownerHumanReviewConfirmed", "externalHumanReviewConfirmed",
            "rightsAndScopeAccredited", "replacementOwnerApproved", "replacementFrozen",
        ]
        if any(field not in row for field in required):
            abort("APPROVAL_FIELDS_MISSING")
        if any(not strict_boolean(row[f]) for f in (
           "ownerHumanReviewConfirmed", "externalHumanReviewConfirmed",
           "rightsAndScopeAccredited", "replacementOwnerApproved", "replacementFrozen")):
            abort("ORIGINAL_ATTESTATION_FLAG_INVALID")
        if row["ownerHumanReviewConfirmed"] != "True" or any(
            row[field] != "False" for field in (
                "externalHumanReviewConfirmed", "rightsAndScopeAccredited",
                "replacementOwnerApproved", "replacementFrozen")):
            abort("ORIGINAL_APPROVAL_STATE_UNEXPECTED")
        key = row["originalReviewCaseKey"]
        original = xc.get(key)
        if not original or original["question"] != row["originalQuestion"] or \
           original["language"] != row["language"]:
            abort("CANDIDATE_SOURCE_QUESTION_IDENTITY_CHANGED")
        src = xs.get(original["sourceKeySha256"])
        if not src or src["originalSha256"] != row["originalSha256"] or \
           src["upstreamRepository"] != row["sourceRepository"]:
            abort("ORIGINAL_SOURCE_IDENTITY_CHANGED")
        if "NOT_EXTERNALLY_AUTHORIZED" not in src.get("authorizedVaultScope", ""):
            abort("UNEXPECTED_SOURCE_RIGHTS_PROVENANCE")
        try:
            spans = json.loads(row["utf16QuoteSpansJson"])
        except ValueError:
            abort("SOURCE_QUOTE_JSON_INVALID")
        if not isinstance(spans, list):
            abort("SOURCE_QUOTE_ARRAY_INVALID")
        seen = set()
        for span in spans:
            if span.get("sourceKeySha256") != original["sourceKeySha256"] or \
               span.get("originalSha256") != row["originalSha256"]:
                abort("QUOTE_SOURCE_CHANGED")
            a,b = span.get("startUtf16"),span.get("endUtf16")
            encoded = src["originalText"].encode("utf-16-le")
            if not isinstance(a,int) or isinstance(a,bool) or \
               not isinstance(b,int) or isinstance(b,bool) or \
               a<0 or b<=a or b>len(encoded)//2:
                abort("QUOTE_OFFSETS_INVALID")
            try:
                text = encoded[a*2:b*2].decode("utf-16-le")
            except UnicodeDecodeError:
                abort("QUOTE_SPLIT_UNICODE")
            if span.get("quote") != text or (a,b) in seen:
                abort("QUOTE_NOT_EXACT_OR_DUPLICATE")
            seen.add((a,b))
        action = row["technicalAdjudication"]
        if action == "REWORD_BEFORE_FREEZE":
            new_key = row["replacementCaseKeySha256"]
            question = row["replacementQuestionProposal"]
            if (not SHA64.fullmatch(new_key) or new_key in new_keys or
                not isinstance(question,str) or len(question)<16 or len(question)>4096 or
                question == row["originalQuestion"] or
                row["proposedAnswerability"] != "ANSWERABLE_EXPLICIT" or not spans):
                abort("INVALID_PROPOSED_REWORD")
            new_keys.add(new_key)
            replacements.append((key,new_key,question))
            owner_decision = "OWNER_APPROVED_REWORD_DEV_CANDIDATE"
        elif action == "RETAIN_NOT_ANSWERABLE_WITH_SCOPE_LIMITATION":
            if (row["caseNumber"] != "138" or row["replacementQuestionProposal"] or
                row["replacementCaseKeySha256"] or spans or
                row["proposedAnswerability"] != "NOT_ANSWERABLE"):
                abort("SCOPE_LIMITED_NEGATIVE_CHANGED")
            owner_decision = "OWNER_APPROVED_RETAIN_SCOPED_NEGATIVE_DEV_CANDIDATE"
        else:
            abort("UNKNOWN_OWNER_EDIT_ACTION")
        approvals.append({
            "caseNumber":row["caseNumber"],
            "originalReviewCaseKey":key,
            "originalQuestionSha256":sha(row["originalQuestion"].encode("utf8")),
            "originalSourceSha256":row["originalSha256"],
            "newCaseKeySha256":row["replacementCaseKeySha256"] or None,
            "newQuestionSha256":sha(row["replacementQuestionProposal"].encode("utf8")) if row["replacementQuestionProposal"] else None,
            "ownerDecision":owner_decision,
            "sourceSpansVerified":len(spans),
            "ownerAuthorityDeclaredByCurrentUser":True,
            "ownerAuthorityCryptographicallyAuthenticated":False,
            "externalReviewerIdentityVerified":False,
            "sourceRightsVerified":False,
            "editorialOwnerApprovalGranted":True,
            "independentSignedFreezeCompleted":False,
            "releaseGateAccepted":False,
        })
    if len(replacements)!=EXPECTED_REWORD or len(approvals)!=EXPECTED_ORIGINAL_CASES or \
       sum(a["ownerDecision"].startswith("OWNER_APPROVED_RETAIN") for a in approvals)!=EXPECTED_RETAIN:
        abort("CANDIDATE_DISTRIBUTION_INVALID")
    output = []
    for reviewer,packet,pin in [("X",x,x_pin),("Y",y,y_pin)]:
        changed=copy.deepcopy(packet)
        originals={old:(new,q) for old,new,q in replacements}
        for case in changed["cases"]:
            ref = originals.get(case["reviewCaseKey"])
            if ref:
                case["reviewCaseKey"]=ref[0]
                case["question"]=ref[1]
        keys=[c["reviewCaseKey"] for c in changed["cases"]]
        if len(keys)!=240 or len(set(keys))!=240 or \
           sum(c["language"]=="en" for c in changed["cases"])!=120 or \
           sum(c["language"]=="es" for c in changed["cases"])!=120:
            abort("REVISED_240_STRUCTURE_INVALID")
        # Deliberately incompatible with the independent source-only reviewer schema.
        # These 240 cases were already exposed to AI and reviewers.
        changed["schemaVersion"]="akp.s2.owner-approved-dev-candidate-packet.v1"
        changed["previousFrozenIntakeSha256"]=changed.pop("frozenIntakeSha256")
        changed["originalFrozenPacketSha256"]=pin
        changed["ownerApprovedEditorialChangeCount"]=8
        changed["independentHoldoutEligible"]=False
        changed["releaseGateAccepted"]=False
        output.append((reviewer,changed))
    manifest = {
        "schemaVersion":"akp.s2.owner-approved-editorial-revision.v1",
        "status":"OWNER_APPROVED_DEV_CANDIDATES_NOT_INDEPENDENT_HOLDOUT",
        "ownerApprovalBasis":"current_user_explicit_project_owner_approval_in_chat_2026-10-29",
        "ownerAuthorityDeclaredByUser":True,
        "ownerAuthorityExternallyAuthenticated":False,
        "inputProposalSha256":proposal_pin,
        "previousPacketHashes":{"X":x_pin,"Y":y_pin},
        "caseCount":240,
        "languageCounts":{"en":120,"es":120},
        "sourceFamilyCount":12,
        "approvedRewordings":8,
        "approvedRetainedScopedNegative":1,
        "revisions":approvals,
        "editorialOwnerApprovalGranted":True,
        "sourceReuseRightsExternallyVerified":False,
        "independentReviewerIdentitiesVerified":False,
        "preInferenceHoldoutSignatureVerified":False,
        "externalGoldAdjudicationComplete":False,
        "producerRuntimePolicyModified":False,
        "releaseGateAccepted":False,
    }
    return manifest,output,rows


def run():
    cli=argparse.ArgumentParser(description=__doc__)
    for name in ("proposal","proposal-sha256","packet-x","packet-x-pin","packet-y","packet-y-pin","output-dir"):
        cli.add_argument("--"+name,required=True)
    a=cli.parse_args()
    repo=pathlib.Path(__file__).resolve().parent.parent
    paths=[pathlib.Path(getattr(a,n.replace("-","_"))).resolve() for n in ("proposal","packet-x","packet-x-pin","packet-y","packet-y-pin","output-dir")]
    if any(path==repo or repo in path.parents for path in paths):
        abort("PRIVATE_PATH_REQUIRED")
    proposal=pathlib.Path(a.proposal).read_bytes()
    def read_packet(letter):
        p=pathlib.Path(getattr(a,"packet_"+letter)).read_bytes()
        pin=pathlib.Path(getattr(a,"packet_"+letter+"_pin")).read_text(encoding="utf8").strip()
        return p,pin
    xb,xpin=read_packet("x"); yb,ypin=read_packet("y")
    manifest,packets,rows=make_revision(proposal,a.proposal_sha256,xb,xpin,yb,ypin)
    output=pathlib.Path(a.output_dir)
    output.mkdir(parents=False,exist_ok=False)
    files={}
    files["OWNER-APPROVAL-RECEIPT.json"]=json.dumps(manifest,indent=2,ensure_ascii=False).encode()+"\n".encode()
    for reviewer,packet in packets:
        files[f"DEV-ONLY-OWNER-APPROVED-{reviewer}-240.json"]=json.dumps(packet,indent=2,ensure_ascii=False).encode()+b"\n"
    fieldnames=list(rows[0])+["ownerDecision","ownerDecisionProvenance","ownerRetentionApproved","independentGoldAccepted"]
    sio=io.StringIO(newline="")
    writer=csv.DictWriter(sio,fieldnames=fieldnames,lineterminator="\r\n")
    writer.writeheader()
    for row in rows:
        rec=next(x for x in manifest["revisions"] if x["caseNumber"]==row["caseNumber"])
        row=dict(row)
        row["replacementOwnerApproved"]="True" if rec["ownerDecision"]=="OWNER_APPROVED_REWORD_DEV_CANDIDATE" else "False"
        row["ownerRetentionApproved"]="True" if rec["ownerDecision"]=="OWNER_APPROVED_RETAIN_SCOPED_NEGATIVE_DEV_CANDIDATE" else "False"
        row["ownerDecision"]=rec["ownerDecision"]
        row["ownerDecisionProvenance"]="explicit-project-owner-chat-2026-10-29"
        row["independentGoldAccepted"]="False"
        writer.writerow(row)
    files["OWNER-APPROVED-NINE-DECISIONS.csv"]=("\ufeff"+sio.getvalue()).encode("utf8")
    files["MANIFEST-OUTPUT-HASHES.json"]=json.dumps({
        "status":"PRIVATE_DEV_ONLY_HASH_RECEIPT",
        "filesSha256":{name:sha(data) for name,data in files.items()},
        "releaseGateAccepted":False},indent=2).encode()+b"\n"
    for name,content in files.items():
        with (output/name).open("xb") as f:
            f.write(content)
    print(json.dumps({"status":manifest["status"],"caseCount":240,
        "reworded":8,"retainedScopedNegative":1,"independentGoldAccepted":False,
        "releaseGateAccepted":False}))


if __name__=="__main__":
    try:run()
    except (OSError,KeyError,ValueError,UnicodeDecodeError,TypeError) as exc:
        print("S2_OWNER_EDIT_ABORTED:"+str(exc),file=sys.stderr)
        sys.exit(1)
