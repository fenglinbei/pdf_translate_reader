const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "/api";

export async function createInviteTicket(email: string, inviteCode: string) {
  const response = await fetch(`${apiBaseUrl}/auth/invite-ticket`, {
    body: JSON.stringify({
      email,
      inviteCode,
    }),
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    method: "POST",
  });

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  const payload = await response.json();

  if (!payload || typeof payload.ticket !== "string" || payload.ticket.length === 0) {
    throw new Error("Invite ticket response is malformed.");
  }

  return payload.ticket;
}

async function readErrorMessage(response: Response) {
  try {
    const payload = await response.json();

    if (typeof payload?.error?.message === "string") {
      return payload.error.message;
    }
  } catch {
    // Fall through to status text.
  }

  return response.statusText || `Request failed with status ${response.status}`;
}
