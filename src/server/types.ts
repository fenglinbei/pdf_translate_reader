export type ApiHealth = {
  status: "ok";
  service: "pdf-translate-reader-api";
  deepseek: {
    apiKeyConfigured: boolean;
  };
  embedding?: {
    configured: boolean;
    dimensions: number;
    model: string;
    provider: string;
  };
  supabase: {
    configured: boolean;
  };
};
