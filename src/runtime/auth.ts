// Bot Framework JWT verification.
//
// Microsoft signs every channel-to-bot call with a JWT; we verify before
// trusting any activity body. Public keys live at the Bot Framework JWKS
// endpoint; jose's createRemoteJWKSet caches them across invocations.

import type { Env } from "../env";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

const BOT_FRAMEWORK_JWKS = createRemoteJWKSet(
  new URL("https://login.botframework.com/v1/.well-known/keys"),
);

// The set of legitimate token issuers Bot Framework / Teams can present.
// Tokens from emulator-style clients use different issuers, intentionally
// not accepted here.
const VALID_ISSUERS = [
  "https://api.botframework.com",
  "https://sts.windows.net/d6d49420-f39b-4df7-a1dc-d59a935871db/",
];

export class BotAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BotAuthError";
  }
}

export async function verifyBotJwt(
  env: Env,
  authHeader: string | null,
): Promise<JWTPayload> {
  if (!authHeader) throw new BotAuthError("missing_auth_header");
  const match = authHeader.match(/^Bearer\s+(.+)$/);
  if (!match) throw new BotAuthError("malformed_auth_header");
  const token = match[1];

  try {
    const result = await jwtVerify(token, BOT_FRAMEWORK_JWKS, {
      audience: env.TEAMS_APP_ID,
      issuer: VALID_ISSUERS,
    });
    return result.payload;
  } catch (e) {
    throw new BotAuthError(`jwt_verify_failed: ${String(e)}`);
  }
}
