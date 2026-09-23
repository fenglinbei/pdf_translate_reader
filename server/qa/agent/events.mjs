// Emits the existing public summaries, never raw model reasoning.
export function createAgentEvents({ emit, insertStep, insertToolCall }) {
  return Object.freeze({
    recordStep: (state, eventName, input) => recordStep(state, eventName, input, { emit, insertStep }),
    async recordToolCall(state, step, input) {
      const toolCall = await insertToolCall(input);
      const stepWithToolCall = { ...step, toolCall };
      state.agentSteps = state.agentSteps.map((item) => item.id === step.id ? stepWithToolCall : item);
      emit?.("tool_call", { step: stepWithToolCall, toolCall });
      return toolCall;
    },
  });
}

async function recordStep(state, eventName, input, { emit, insertStep }) {
  if (state.nextStepIndex >= state.maxSteps) {
    return {
      createdAt: Date.now(),
      evidenceIds: input.evidenceIds ?? [],
      id: `skipped-step-${state.nextStepIndex}`,
      kind: input.kind,
      messageId: state.messageId,
      payload: input.payload,
      status: "skipped",
      stepIndex: state.nextStepIndex,
      summary: input.summary,
      toolName: input.toolName,
    };
  }

  const step = await insertStep({
    evidenceIds: input.evidenceIds ?? [],
    kind: input.kind,
    messageId: state.messageId,
    payload: input.payload,
    status: input.status ?? "success",
    stepIndex: state.nextStepIndex,
    summary: input.summary,
    toolName: input.toolName,
    userId: state.userId,
  });

  state.nextStepIndex += 1;
  state.agentSteps.push(step);
  if (eventName) {
    emit?.(eventName, { step });
  }

  return step;
}
