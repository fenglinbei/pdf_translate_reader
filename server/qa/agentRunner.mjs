// Composition root: wire external services here, keep agent/ dependency-injected.
import { retrieveCurrentPaperEvidence } from "./retriever.mjs";
import { insertQaAgentStep, insertQaToolCall } from "../supabase/qa.mjs";
import { createQaChatCompletion } from "../chatModels/client.mjs";
import { createQaControllerAdapter } from "./agent/controller.mjs";
import { runReasoningAgenticRetrieval as runReasoningLoop } from "./agent/loop.mjs";
import { runAgenticRetrieval } from "./agent/heuristicLoop.mjs";

export { QaAgentRunnerError } from "./agent/errors.mjs";
export { runAgenticRetrieval };

const callReasoningController = createQaControllerAdapter({ complete: createQaChatCompletion });

export async function runReasoningAgenticRetrieval(input) {
  return runReasoningLoop({ ...input, callController: input.callController ?? callReasoningController });
}

export async function runCurrentPaperAgenticRetrieval(input) {
  return runAgenticRetrieval({
    ...input,
    insertStep: insertQaAgentStep,
    insertToolCall: insertQaToolCall,
    retrieveEvidence: retrieveCurrentPaperEvidence,
  });
}

export async function runCurrentPaperReasoningRetrieval(input) {
  const controller = input.runContext ? createQaControllerAdapter({ complete: async args => input.runContext.modelCall('agent_retrieval', async () => {
    const result = await createQaChatCompletion(args);
    input.runContext.events.modelUsage(result.usage);
    return result;
  }) }) : callReasoningController;
  return runReasoningAgenticRetrieval({
    ...input,
    callController: input.callController ?? controller,
    insertStep: input.runContext?.insertStep ?? insertQaAgentStep,
    insertToolCall: insertQaToolCall,
    retrieveEvidence: retrieveCurrentPaperEvidence,
  });
}
