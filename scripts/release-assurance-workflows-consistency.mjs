/**
 * A GitHub workflow may already report success while its jobs API still
 * returns a stale step snapshot. Release evidence must never accept it.
 */
export function classifySameShaJobSnapshot(jobs) {
  if (!Array.isArray(jobs) || jobs.length === 0) {
    return { status: "PENDING", detail: "job list not populated" };
  }
  for (const job of jobs) {
    if (!job || job.status !== "completed" || !job.conclusion) {
      return { status: "PENDING", detail: "job not finalized" };
    }
    if (job.conclusion !== "success") {
      return { status: "FAILED", detail: "job did not succeed" };
    }
    if (!Array.isArray(job.steps) || job.steps.length === 0) {
      return { status: "PENDING", detail: "steps not populated" };
    }
    for (const step of job.steps) {
      if (
        !step ||
        step.status !== "completed" ||
        typeof step.conclusion !== "string" ||
        !step.conclusion
      ) {
        return { status: "PENDING", detail: "step not finalized" };
      }
    }
  }
  return { status: "READY", detail: "all jobs and steps finalized" };
}
