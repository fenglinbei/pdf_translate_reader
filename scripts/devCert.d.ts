declare module "./scripts/devCert.mjs" {
  export function generateSelfSignedCert():
    | { cert: string; key: string }
    | undefined;
}
