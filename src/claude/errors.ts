/** Errors a turn can end with, and how upstream failures map onto them. */
import { errorMessage } from "../logger.js";

export class ApiError extends Error {
  constructor(readonly status: number, readonly type: string, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

export class ClientAbort extends Error {
  constructor() {
    super("client disconnected");
    this.name = "ClientAbort";
  }
}

/** A resumed session's transcript is gone; the caller replays the history. */
export class ResumeFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResumeFailed";
  }
}

export function isMissingSession(error: unknown): boolean {
  const message = errorMessage(error);
  return /no conversation found|session.*(not found|does not exist)|could not find.*session/i.test(
    message,
  );
}

export function errorFor(result: {
  type: string;
  message: string;
  status?: number;
  resetAt?: number;
}): ApiError {
  const type = result.type.toLowerCase();
  const haystack = `${type} ${result.message}`.toLowerCase();
  const reset = result.resetAt
    ? ` Resets at ${new Date(result.resetAt).toISOString()}.`
    : "";
  const message = `${result.message}${reset}`;

  if (result.status !== undefined) {
    if (result.status === 401) return new ApiError(401, "authentication_error", message);
    if (result.status === 403) return new ApiError(403, "permission_error", message);
    if (result.status === 404) return new ApiError(404, "not_found_error", message);
    if (result.status === 429) return new ApiError(429, "rate_limit_error", message);
    if (result.status === 529) return new ApiError(529, "overloaded_error", message);
    if (result.status >= 500) return new ApiError(502, "api_error", message);
    if (result.status >= 400) return new ApiError(400, "invalid_request_error", message);
  }

  if (haystack.includes("rate_limit")) return new ApiError(429, "rate_limit_error", message);
  if (haystack.includes("overloaded")) return new ApiError(529, "overloaded_error", message);
  if (
    haystack.includes("authentication") ||
    haystack.includes("authenticate") ||
    haystack.includes("oauth") ||
    haystack.includes("credential") ||
    haystack.includes("login")
  )
    return new ApiError(401, "authentication_error", message);
  if (haystack.includes("permission")) return new ApiError(403, "permission_error", message);
  if (type.includes("model_not_found")) return new ApiError(404, "not_found_error", message);
  if (type.includes("invalid_request")) return new ApiError(400, "invalid_request_error", message);
  if (type.includes("refusal")) return new ApiError(400, "invalid_request_error", message);
  return new ApiError(502, "api_error", message);
}
