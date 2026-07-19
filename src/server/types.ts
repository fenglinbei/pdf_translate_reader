export type ApiHealth = {
  status: "ok";
  service: "pdf-translate-reader-api";
  deepseek: {
    apiKeyConfigured: boolean;
  };
  translation?: {
    deepseek: {
      apiKeyConfigured: boolean;
    };
    glm: {
      apiKeyConfigured: boolean;
    };
    kimi: {
      apiKeyConfigured: boolean;
    };
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
