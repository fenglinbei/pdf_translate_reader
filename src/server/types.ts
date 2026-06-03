export type ApiHealth = {
  status: "ok";
  service: "pdf-translate-reader-api";
  deepseek: {
    apiKeyConfigured: boolean;
  };
  supabase: {
    configured: boolean;
  };
};
