// Signed cookie sealing for the Microsoft SSO session.
//
// Payload is base64url JSON with an HMAC-SHA256 tag over it, keyed by
// SSO_SESSION_SECRET. The browser holds an opaque, unforgeable blob: nothing
// here is encrypted, so never seal anything the holder may not read. The
// signature is what carries the identity claim.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function b64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Backed by an explicit ArrayBuffer rather than `new Uint8Array(length)`, so
// the result satisfies BufferSource for WebCrypto without a cast.
function b64urlDecode(text: string) {
  const padding = text.length % 4 === 0 ? "" : "=".repeat(4 - (text.length % 4));
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/") + padding);
  const out = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

export async function seal(secret: string, value: unknown): Promise<string> {
  const payload = b64urlEncode(encoder.encode(JSON.stringify(value)));
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(payload));
  return `${payload}.${b64urlEncode(new Uint8Array(signature))}`;
}

/** Returns null for anything that is not an intact, correctly signed payload. */
export async function unseal<T>(secret: string, token: string | undefined | null): Promise<T | null> {
  if (!token) return null;
  const split = token.lastIndexOf(".");
  if (split <= 0 || split === token.length - 1) return null;
  const payload = token.slice(0, split);
  try {
    // crypto.subtle.verify compares in constant time — never do this by hand.
    const ok = await crypto.subtle.verify(
      "HMAC",
      await hmacKey(secret),
      b64urlDecode(token.slice(split + 1)),
      encoder.encode(payload)
    );
    if (!ok) return null;
    return JSON.parse(decoder.decode(b64urlDecode(payload))) as T;
  } catch {
    return null;
  }
}

export function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get("Cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

/**
 * SameSite=Lax rather than Strict: the browser arrives back from
 * login.microsoftonline.com on a cross-site top-level navigation, and Strict
 * would withhold the cookie on exactly that request and loop the login.
 */
export function setCookie(name: string, value: string, maxAgeSeconds: number): string {
  return [
    `${name}=${value}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
  ].join("; ");
}

export function clearCookie(name: string): string {
  return `${name}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

/** URL-safe random string for state, nonce, and the PKCE verifier. */
export function randomToken(bytes = 32): string {
  return b64urlEncode(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function s256Challenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(verifier));
  return b64urlEncode(new Uint8Array(digest));
}
