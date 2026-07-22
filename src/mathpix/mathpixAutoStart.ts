export type MathpixAutoStartInput = {
  enabled: boolean;
  fingerprint?: string;
  isSettingsHydrated: boolean;
  pipelineState: "idle" | "running" | "scheduled";
  startedFingerprint?: string;
};

export function shouldAutoStartMathpix({
  enabled,
  fingerprint,
  isSettingsHydrated,
  pipelineState,
  startedFingerprint,
}: MathpixAutoStartInput) {
  return Boolean(
    isSettingsHydrated &&
      enabled &&
      fingerprint &&
      pipelineState === "idle" &&
      startedFingerprint !== fingerprint,
  );
}
