import { sign, verify, AlgorithmTypes } from "hono/jwt";

export const AUTH_COOKIE = "nne_session";
export const JWT_ALG: AlgorithmTypes = AlgorithmTypes.HS256;
export const JWT_TTL_SEC = 60 * 60 * 24 * 7;
// Password-based sessions must not survive the switch to Google accounts.
export const JWT_ISSUER = "netnoveleditor:google";

export interface JWTPayload {
  sub: string;
  email: string;
  iat: number;
  nbf: number;
  exp: number;
  iss: string;
  [key: string]: unknown;
}

export async function signSessionToken(
  secret: string,
  payload: { sub: string; email: string },
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const fullPayload: JWTPayload = {
    sub: payload.sub,
    email: payload.email,
    iat: now,
    nbf: now,
    exp: now + JWT_TTL_SEC,
    iss: JWT_ISSUER,
  };
  return await sign(fullPayload, secret, JWT_ALG);
}

export async function verifySessionToken(token: string, secret: string): Promise<JWTPayload> {
  const decoded = (await verify(token, secret, JWT_ALG)) as Partial<JWTPayload> | null;
  if (!decoded || typeof decoded !== "object") {
    throw new Error("invalid token payload");
  }
  if (decoded.iss !== JWT_ISSUER) {
    throw new Error("invalid issuer");
  }
  if (typeof decoded.sub !== "string" || typeof decoded.email !== "string") {
    throw new Error("invalid subject");
  }
  return decoded as JWTPayload;
}
