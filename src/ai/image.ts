// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Image Generation
//
// Detects image-creation intent from user messages, generates images via
// Cloudflare Workers AI (Stable Diffusion XL Lightning), stores them in KV
// with a short TTL, and serves them via GET /api/image/:id.
// ─────────────────────────────────────────────────────────────────────────────

import type { Env } from "../types.js";
import { KV_KEYS } from "../constants.js";

const IMAGE_MODEL = "@cf/bytedance/stable-diffusion-xl-lightning";
const IMAGE_TTL = 3600; // 1 hour — long enough for Teams card preview to load

// ─── Intent detection ─────────────────────────────────────────────────────────

const IMAGE_TRIGGERS_ES = [
	"genera una imagen", "crea una imagen", "genera imagen", "crea imagen",
	"genera un dibujo", "crea un dibujo", "dibuja", "ilustra", "diseña una imagen",
	"pinta", "muéstrame una imagen", "muéstrame un dibujo", "visualiza",
	"hazme una imagen", "hazme un dibujo",
];

const IMAGE_TRIGGERS_EN = [
	"generate an image", "create an image", "generate image", "create image",
	"draw", "illustrate", "render an image", "paint", "show me a picture",
	"make an image", "make a picture", "design an image",
];

/**
 * Returns true if the user is asking for an image to be created.
 * Simple keyword scan — fast and zero overhead on non-image requests.
 */
export function detectImageIntent(text: string): boolean {
	const lower = text.toLowerCase();
	return [...IMAGE_TRIGGERS_ES, ...IMAGE_TRIGGERS_EN].some((kw) => lower.includes(kw));
}

// ─── Generation ──────────────────────────────────────────────────────────────

/**
 * Generate an image from `prompt`, store it in KV, and return its serving URL.
 * Returns null if generation fails (caller falls back to text response).
 */
export async function generateAndStoreImage(
	prompt: string,
	env: Env,
	workerUrl: string,
): Promise<{ url: string } | null> {
	try {
		const result = await env.AI.run(
			IMAGE_MODEL as Parameters<typeof env.AI.run>[0],
			{ prompt, num_steps: 4 } as Parameters<typeof env.AI.run>[1],
		);

		// Image models return a ReadableStream<Uint8Array>
		const arrayBuffer = await new Response(result as ReadableStream).arrayBuffer();
		if (!arrayBuffer.byteLength) {
			console.warn("[Arcadia] Image generation returned empty buffer");
			return null;
		}

		const id = crypto.randomUUID();
		await env.ARCADIA_CACHE.put(KV_KEYS.IMG(id), arrayBuffer, { expirationTtl: IMAGE_TTL });

		return { url: `${workerUrl.replace(/\/$/, "")}/api/image/${id}` };
	} catch (err) {
		console.error("[Arcadia] Image generation failed:", err);
		return null;
	}
}

// ─── Serving ─────────────────────────────────────────────────────────────────

/**
 * Retrieve a previously generated image from KV and return an HTTP response.
 * Returns null when the image has expired or the ID is unknown.
 */
export async function serveStoredImage(id: string, env: Env): Promise<Response | null> {
	const arrayBuffer = await env.ARCADIA_CACHE.get(KV_KEYS.IMG(id), "arrayBuffer");
	if (!arrayBuffer) return null;
	return new Response(arrayBuffer, {
		headers: {
			"Content-Type": "image/png",
			"Cache-Control": "public, max-age=3600",
		},
	});
}
