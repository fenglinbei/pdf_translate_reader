import { writeJson } from "../http/json.mjs";
import { requireSupabaseServiceClient, SupabaseServiceError } from "../supabase/service.mjs";

const MAX_REQUEST_BYTES = 16 * 1024;

export async function handleInviteTicket(request, response) {
  let inviteRequest;

  try {
    inviteRequest = normalizeInviteTicketRequest(await readJsonBody(request));
  } catch (error) {
    writeJson(response, 400, {
      error: {
        code: "invalid_invite_ticket_request",
        message: error instanceof Error ? error.message : "Invalid invite request.",
      },
    });
    return;
  }

  try {
    const client = requireSupabaseServiceClient();
    const { data, error } = await client.rpc("create_signup_invite_ticket", {
      invite_code: inviteRequest.inviteCode,
      signup_email: inviteRequest.email,
    });

    if (error) {
      throw error;
    }

    if (data?.error) {
      writeJson(response, getInviteErrorStatusCode(data.error.code), {
        error: data.error,
      });
      return;
    }

    if (typeof data?.ticket !== "string" || data.ticket.length === 0) {
      throw new Error("Invite ticket response is malformed.");
    }

    writeJson(response, 200, {
      expiresAt: data.expires_at,
      ticket: data.ticket,
    });
  } catch (error) {
    const statusCode = error instanceof SupabaseServiceError ? error.statusCode : 500;

    if (!(error instanceof SupabaseServiceError)) {
      console.error("Invite ticket creation failed:", error);
    }

    writeJson(response, statusCode, {
      error: {
        code: error instanceof SupabaseServiceError ? error.code : "invite_ticket_error",
        message: error instanceof SupabaseServiceError
          ? "Invite registration is not configured."
          : "Invite ticket could not be created.",
      },
    });
  }
}

function normalizeInviteTicketRequest(body) {
  if (!body || typeof body !== "object") {
    throw new Error("Request body must be an object.");
  }

  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const inviteCode = typeof body.inviteCode === "string" ? body.inviteCode.trim() : "";

  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new Error("A valid email address is required.");
  }

  if (inviteCode.length < 6) {
    throw new Error("Invite code is required.");
  }

  return {
    email,
    inviteCode,
  };
}

function getInviteErrorStatusCode(code) {
  if (code === "invalid_signup_email") {
    return 400;
  }

  return 403;
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.length;

    if (size > MAX_REQUEST_BYTES) {
      throw new Error("Request body is too large.");
    }

    chunks.push(chunk);
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
