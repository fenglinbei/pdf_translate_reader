export const QA_INDEX_ACTIVE_STATUSES = [
  "pending",
  "extracting",
  "chunking",
  "embedding",
  "reference-matching",
];

const activeStatusSet = new Set(QA_INDEX_ACTIVE_STATUSES);

export function isActiveQaIndexJobStatus(status) {
  return activeStatusSet.has(status);
}

export function enqueueQaIndexJob(job) {
  // Step 3 only establishes the control plane. Step 4+ will attach real work here.
  return job;
}

