import type { ApiHealth } from "./types";

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "/api";

export async function getApiHealth(): Promise<ApiHealth> {
  const response = await fetch(`${apiBaseUrl}/health`, {
    headers: {
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Health check failed with status ${response.status}`);
  }

  return response.json() as Promise<ApiHealth>;
}
