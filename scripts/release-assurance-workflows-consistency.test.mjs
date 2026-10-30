import test from "node:test";
import assert from "node:assert/strict";
import { classifySameShaJobSnapshot } from "./release-assurance-workflows-consistency.mjs";

const succeeded = () => [
  {
    name: "typescript",
    status: "completed",
    conclusion: "success",
    steps: [
      {
        name: "Run pnpm docs:validate",
        status: "completed",
        conclusion: "success",
      },
      {
        name: "Optional alternate",
        status: "completed",
        conclusion: "skipped",
      },
    ],
  },
];

test("rejects stale in-progress step inside a completed successful job", () => {
  const jobs = succeeded();
  jobs[0].steps[0].status = "in_progress";
  jobs[0].steps[0].conclusion = null;
  assert.deepEqual(classifySameShaJobSnapshot(jobs), {
    status: "PENDING",
    detail: "step not finalized",
  });
});

test("rejects the stale pending test step shown in actual failing CI evidence", () => {
  const jobs = succeeded();
  jobs[0].steps.push({
    name: "Verify opt-in S2 original SOURCE and Writer custody with real HTTP",
    status: "pending",
    conclusion: null,
  });
  assert.equal(classifySameShaJobSnapshot(jobs).status, "PENDING");
});

test("does not treat empty, missing or pending job snapshots as passed", () => {
  assert.equal(classifySameShaJobSnapshot([]).status, "PENDING");
  assert.equal(classifySameShaJobSnapshot(null).status, "PENDING");
  const jobs = succeeded();
  jobs[0].steps = [];
  assert.equal(classifySameShaJobSnapshot(jobs).status, "PENDING");
});

test("rejects a completed failed job regardless of the workflow summary", () => {
  const jobs = succeeded();
  jobs[0].conclusion = "failure";
  assert.equal(classifySameShaJobSnapshot(jobs).status, "FAILED");
});

test("accepts eventual successful step data including legitimate skipped steps", () => {
  assert.equal(classifySameShaJobSnapshot(succeeded()).status, "READY");
});

test("accepts only when all jobs have fully finalized their steps", () => {
  const jobs = succeeded();
  jobs.push({
    name: "python",
    status: "completed",
    conclusion: "success",
    steps: [{ name: "Test", status: "in_progress", conclusion: null }],
  });
  assert.equal(classifySameShaJobSnapshot(jobs).status, "PENDING");
  jobs[1].steps[0].status = "completed";
  jobs[1].steps[0].conclusion = "success";
  assert.equal(classifySameShaJobSnapshot(jobs).status, "READY");
});
