import { sign, verify, AlgorithmTypes } from "hono/jwt"
import type { JwtVariables } from "hono/jwt"

export const AUTH_COOKIE = "nne_session"
export const JWT_ALG: AlgorithmTypes = AlgorithmTypes.HS256
export const JWT_TTL_SEC = 60 * 60 * 24 * 7
export const JWT_ISSUER = "netnoveleditor"
export const PBKDF2_ITERATIONS = 100_000
export const PBKDF2_HASH = "SHA-256"
const SALT_BYTES = 16
const KEY_BITS = 256

export interface JWTPayload {
  sub: string
  email: string
  iat: number
  nbf: number
  exp: number
  iss: string
  [key: string]: unknown
}

const enc = new TextEncoder()

function toBase64(bytes: Uint8Array): string {
  let bin = ""
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

async function deriveBits(
  password: string,
  salt: Uint8Array,
  iterations: number
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveBits"]
  )
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: salt as BufferSource,
      iterations,
      hash: PBKDF2_HASH,
    },
    key,
    KEY_BITS
  )
  return new Uint8Array(bits)
}

export async function hashPassword(password: string): Promise<string> {
  const salt = new Uint8Array(SALT_BYTES)
  crypto.getRandomValues(salt)
  const hash = await deriveBits(password, salt, PBKDF2_ITERATIONS)
  return `pbkdf2$${PBKDF2_ITERATIONS}$${toBase64(salt)}$${toBase64(hash)}`
}

export async function verifyPassword(
  password: string,
  stored: string
): Promise<boolean> {
  const parts = stored.split("$")
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false
  const iterations = Number.parseInt(parts[1], 10)
  if (!Number.isFinite(iterations) || iterations <= 0) return false
  let salt: Uint8Array
  let expected: Uint8Array
  try {
    salt = fromBase64(parts[2])
    expected = fromBase64(parts[3])
  } catch {
    return false
  }
  const actual = await deriveBits(password, salt, iterations)
  if (actual.length !== expected.length) return false
  let diff = 0
  for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i]
  return diff === 0
}

export async function signSessionToken(
  secret: string,
  payload: { sub: string; email: string }
): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const fullPayload: JWTPayload = {
    sub: payload.sub,
    email: payload.email,
    iat: now,
    nbf: now,
    exp: now + JWT_TTL_SEC,
    iss: JWT_ISSUER,
  }
  return await sign(fullPayload, secret, JWT_ALG)
}

export async function verifySessionToken(
  token: string,
  secret: string
): Promise<JWTPayload> {
  const decoded = (await verify(token, secret, JWT_ALG)) as Partial<JWTPayload> | null
  if (!decoded || typeof decoded !== "object") {
    throw new Error("invalid token payload")
  }
  if (decoded.iss !== JWT_ISSUER) {
    throw new Error("invalid issuer")
  }
  if (typeof decoded.sub !== "string" || typeof decoded.email !== "string") {
    throw new Error("invalid subject")
  }
  return decoded as JWTPayload
}

export type AuthVariables = JwtVariables
