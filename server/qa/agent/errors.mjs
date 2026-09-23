// The public facade re-exports the same error identity.
export class QaAgentRunnerError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "QaAgentRunnerError";
    this.agentSteps = options.agentSteps ?? [];
    this.cause = options.cause;
    this.nextStepIndex = options.nextStepIndex ?? 0;
  }
}
