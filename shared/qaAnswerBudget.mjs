// Source validity, persistence capacity and visible UI previews are separate.
// Keep the RPC budget in sync through the migration boundary test.
export const QA_ANSWER_BUDGET = Object.freeze({ maxCitations: 128, maxAnswerChars: 160000, maxRepairReferences: 16 });
