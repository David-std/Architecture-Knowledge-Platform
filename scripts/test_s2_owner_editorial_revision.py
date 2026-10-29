"""Synthetic-only regression tests of project-owner editorial authority isolation."""
import copy
import csv
import hashlib
import importlib.util
import io
import json
import pathlib
import unittest

SCRIPT = pathlib.Path(__file__).with_name("s2-prepare-owner-editorial-revision.py")
spec = importlib.util.spec_from_file_location("s2_owner_editorial_revision", SCRIPT)
impl = importlib.util.module_from_spec(spec)
spec.loader.exec_module(impl)

sha = lambda x: hashlib.sha256(x.encode("utf8") if isinstance(x,str) else x).hexdigest()
as_bytes = lambda x: json.dumps(x,ensure_ascii=False).encode("utf8")
CASE_NUMBERS = ["2","13","19","39","72","100","134","138","147"]


def fixture():
    docs = []
    for idx in range(12):
        text = f"Independent document {idx}: 🔥 example supports version 14 of the endpoint."
        docs.append({
            "sourceKeySha256":sha("source-"+str(idx)),
            "originalSha256":sha(text),
            "originalText":text,
            "upstreamRepository":"publisher/repo-"+str(idx),
            "revision40Hex":"b"*40,
            "relativePath":"README.md",
            "authorizedVaultScope":f"candidate-F{idx:02d}-NOT_EXTERNALLY_AUTHORIZED",
        })
    cases = []
    for idx in range(240):
        doc = docs[idx%12]
        cases.append({
            "reviewCaseKey":sha("case-"+str(idx)),
            "language":"en" if idx%2==0 else "es",
            "question":f"What is documented for local reference case {idx}?",
            "sourceKeySha256":doc["sourceKeySha256"],
            "sourceAnswerability":None,
            "reviewerAnswer":None,
            "supportingQuoteSpans":[],
            "wholeAuthorizedCorpusAbsenceChecked":None,
            "reviewerNotes":None,
        })
    def packet(role):
        return {
            "schemaVersion":"akp.s2.preinference-original-source-review.v1",
            "reviewer":role,"frozenIntakeSha256":sha("original-intake"),
            "sourceDocs":copy.deepcopy(docs),"cases":copy.deepcopy(cases),
            "expectedGoldIncluded":False,"modelOutputsIncluded":False,
            "reviewerIdentityAuthenticated":False,"wholeAuthorizedCorpusAbsenceProven":False,
            "independentGoldAdjudicated":False,"releaseGateAccepted":False,
        }
    rows=[]
    for offset,number in enumerate(CASE_NUMBERS):
        case=cases[offset]
        doc=docs[offset%12]
        retained=number=="138"
        span_len=len(doc["originalText"].encode("utf-16-le"))//2
        spans=[] if retained else [{
            "startUtf16":0,"endUtf16":span_len,
            "quote":doc["originalText"],"sourceKeySha256":doc["sourceKeySha256"],
            "originalSha256":doc["originalSha256"],
        }]
        rows.append({
            "caseNumber":number,
            "originalReviewCaseKey":case["reviewCaseKey"],
            "language":case["language"],
            "currentQuestionTechnicalDisposition":"NOT_ANSWERABLE" if retained else "AMBIGUOUS",
            "technicalAdjudication":"RETAIN_NOT_ANSWERABLE_WITH_SCOPE_LIMITATION" if retained else "REWORD_BEFORE_FREEZE",
            "sourceRepository":doc["upstreamRepository"],
            "originalQuestion":case["question"],
            "replacementQuestionProposal":"" if retained else f"In this original documentation example, what is the local case {offset} value?",
            "replacementCaseKeySha256":"" if retained else sha("replacement-"+str(offset)),
            "proposedAnswerability":"NOT_ANSWERABLE" if retained else "ANSWERABLE_EXPLICIT",
            "proposedAnswer":"" if retained else "version 14",
            "originalSha256":doc["originalSha256"],
            "utf16QuoteSpansJson":json.dumps(spans,ensure_ascii=False),
            "correctionReason":"Synthetic-only source-based scope correction",
            "rightsAndScopeAccredited":"False",
            "ownerHumanReviewConfirmed":"True",
            "externalHumanReviewConfirmed":"False",
            "replacementOwnerApproved":"False",
            "replacementFrozen":"False",
        })
    buff=io.StringIO(newline="")
    writer=csv.DictWriter(buff,fieldnames=list(rows[0]),lineterminator="\n")
    writer.writeheader()
    writer.writerows(rows)
    csv_bytes=buff.getvalue().encode("utf8")
    xb=as_bytes(packet("X"))
    yb=as_bytes(packet("Y"))
    return csv_bytes,sha(csv_bytes),xb,sha(xb),yb,sha(yb)


class OwnerEditorialApprovalTest(unittest.TestCase):
    def evaluate(self, modify=None):
        inputs=list(fixture())
        if modify:modify(inputs)
        return impl.make_revision(*inputs)

    def assert_rejected(self, mutate, message):
        with self.assertRaisesRegex(ValueError,message):
            self.evaluate(mutate)

    def test_owner_changes_revise_only_internal_dev_not_independent_gold(self):
        manifest, packets, rows = self.evaluate()
        self.assertEqual(manifest["approvedRewordings"],8)
        self.assertEqual(manifest["approvedRetainedScopedNegative"],1)
        self.assertEqual(len(manifest["revisions"]),9)
        self.assertFalse(manifest["releaseGateAccepted"])
        self.assertFalse(manifest["sourceReuseRightsExternallyVerified"])
        self.assertFalse(manifest["ownerAuthorityExternallyAuthenticated"])
        for role,packet in packets:
            self.assertEqual(packet["schemaVersion"],"akp.s2.owner-approved-dev-candidate-packet.v1")
            self.assertEqual(len(packet["cases"]),240)
            self.assertEqual(len(set(c["reviewCaseKey"] for c in packet["cases"])),240)
            self.assertEqual(len(packet["sourceDocs"]),12)
            self.assertNotIn("frozenIntakeSha256",packet)
            self.assertTrue(packet["previousFrozenIntakeSha256"])
            self.assertFalse(packet["independentHoldoutEligible"])
        self.assertTrue(any(x["ownerDecision"].startswith("OWNER_APPROVED_RETAIN") for x in manifest["revisions"]))

    def test_mismatched_input_csv_pin_rejected(self):
        self.assert_rejected(lambda args:args.__setitem__(1,"0"*64),"PROPOSAL_PIN_INVALID")

    def test_changed_proposed_quote_rejected(self):
        def change(args):
            text=args[0].decode()
            args[0]=text.replace("🔥 example","unrelated invented example").encode()
            args[1]=sha(args[0])
        self.assert_rejected(change,"QUOTE_NOT_EXACT_OR_DUPLICATE")

    def test_nonreviewed_owner_attestation_refused(self):
        def change(args):
            rows=list(csv.DictReader(io.StringIO(args[0].decode("utf8"))))
            rows[0]["ownerHumanReviewConfirmed"]="False"
            buff=io.StringIO(newline="")
            writer=csv.DictWriter(buff,fieldnames=list(rows[0]),lineterminator="\n")
            writer.writeheader(); writer.writerows(rows)
            args[0]=buff.getvalue().encode("utf8")
            args[1]=sha(args[0])
        self.assert_rejected(change,"ORIGINAL_APPROVAL_STATE_UNEXPECTED")

    def test_unapproved_origin_scope_rejected(self):
        def change(args):
            pkt=json.loads(args[2])
            pkt["sourceDocs"][0]["authorizedVaultScope"]="already-authorized"
            args[2]=as_bytes(pkt);args[3]=sha(args[2])
            pkt2=json.loads(args[4])
            pkt2["sourceDocs"][0]["authorizedVaultScope"]="already-authorized"
            args[4]=as_bytes(pkt2);args[5]=sha(args[4])
        self.assert_rejected(change,"UNEXPECTED_SOURCE_RIGHTS_PROVENANCE")

    def test_mismatched_original_reviewer_packet_rejected(self):
        def change(args):
            pkt=json.loads(args[4])
            pkt["cases"][0]["question"]="Unauthorized changed question"
            args[4]=as_bytes(pkt);args[5]=sha(args[4])
        self.assert_rejected(change,"XY_QUESTION_OR_SCOPE_CHANGED")

    def test_duplicate_replacement_sha_rejected(self):
        def change(args):
            text=args[0].decode()
            old=sha("replacement-1")
            new=sha("replacement-0")
            args[0]=text.replace(old,new).encode()
            args[1]=sha(args[0])
        self.assert_rejected(change,"INVALID_PROPOSED_REWORD")

    def test_attempted_source_sha_forgery_rejected(self):
        def change(args):
            pkt=json.loads(args[2])
            pkt["sourceDocs"][0]["originalSha256"]="c"*64
            args[2]=as_bytes(pkt);args[3]=sha(args[2])
        self.assert_rejected(change,"ORIGINAL_SOURCE_BYTES_CHANGED")


if __name__=="__main__":
    unittest.main()
