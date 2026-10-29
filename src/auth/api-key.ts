import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

function equal(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Consumers may send either `x-api-key` or `Authorization: Bearer`. */
export function presentedApiKey(req: IncomingMessage): string | undefined {
  const header = req.headers["x-api-key"];
  if (typeof header === "string" && header.trim()) return header.trim();
  const authorization = req.headers.authorization;
  if (typeof authorization === "string") {
    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
    if (match?.[1]) return match[1].trim();
  }
  return undefined;
}

export function isAuthorized(req: IncomingMessage, expected: string): boolean {
  const presented = presentedApiKey(req);
  return Boolean(presented) && equal(presented!, expected);
}
