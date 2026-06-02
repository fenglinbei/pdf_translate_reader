export function getDeepSeekRuntimeConfig() {
  return {
    apiBaseUrl: process.env.DEEPSEEK_API_BASE_URL ?? "https://api.deepseek.com",
    apiKey: process.env.DEEPSEEK_API_KEY,
    apiKeyConfigured: Boolean(process.env.DEEPSEEK_API_KEY),
  };
}
