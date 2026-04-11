// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Webapp Token Encryption (Phase 7)
//
// AES-GCM encryption for user Graph tokens stored in D1.
// Uses the Web Crypto API (available in Cloudflare Workers).
// ─────────────────────────────────────────────────────────────────────────────

const ALGO = "AES-GCM";
const IV_LENGTH = 12;       // 96-bit IV recommended for AES-GCM
const KEY_LENGTH = 256;     // 256-bit key

/**
 * Derives an AES-256-GCM CryptoKey from the session secret string.
 * Uses HKDF with a fixed salt to produce a deterministic key.
 */
async function deriveKey(secret: string): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    "HKDF",
    false,
    ["deriveKey"]
  );

  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: encoder.encode("arcadia-webapp-token-encryption"),
      info: encoder.encode("token-key"),
    },
    keyMaterial,
    { name: ALGO, length: KEY_LENGTH },
    false,
    ["encrypt", "decrypt"]
  );
}

/**
 * Encrypts a plaintext string using AES-256-GCM.
 * Returns a base64-encoded string containing IV + ciphertext.
 */
export async function encryptToken(plaintext: string, secret: string): Promise<string> {
  const key = await deriveKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const encoder = new TextEncoder();

  const ciphertext = await crypto.subtle.encrypt(
    { name: ALGO, iv },
    key,
    encoder.encode(plaintext)
  );

  // Prepend IV to ciphertext
  const combined = new Uint8Array(IV_LENGTH + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), IV_LENGTH);

  return btoa(String.fromCharCode(...combined));
}

/**
 * Decrypts a base64-encoded IV+ciphertext string produced by encryptToken.
 */
export async function decryptToken(encrypted: string, secret: string): Promise<string> {
  const key = await deriveKey(secret);
  const combined = Uint8Array.from(atob(encrypted), (c) => c.charCodeAt(0));

  const iv = combined.slice(0, IV_LENGTH);
  const ciphertext = combined.slice(IV_LENGTH);

  const plaintext = await crypto.subtle.decrypt(
    { name: ALGO, iv },
    key,
    ciphertext
  );

  return new TextDecoder().decode(plaintext);
}

/**
 * Creates an HMAC-SHA256 signature for a session ID.
 * Used to sign session cookies so they can't be forged.
 */
export async function signSessionId(sessionId: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(sessionId));
  // Return hex-encoded signature
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Verifies an HMAC-SHA256 signature for a session ID.
 */
export async function verifySessionSignature(
  sessionId: string,
  signature: string,
  secret: string
): Promise<boolean> {
  const expected = await signSessionId(sessionId, secret);
  // Constant-time comparison via subtle.verify would be ideal,
  // but for hex string comparison this is acceptable in this context.
  if (expected.length !== signature.length) return false;
  let result = 0;
  for (let i = 0; i < expected.length; i++) {
    result |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return result === 0;
}
