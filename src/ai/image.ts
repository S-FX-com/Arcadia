// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Image Generation
//
// Detects image-creation intent, generates images via Cloudflare Workers AI,
// stores them in KV with a short TTL, and serves them via GET /api/image/:id.
// Phase 10: multi-model support via ImageModel type.
// ─────────────────────────────────────────────────────────────────────────────

import type { Env } from "../types.js";
import { KV_KEYS } from "../constants.js";
import { MODEL_REGISTRY } from "./model-registry.js";

const IMAGE_TTL = 3600; // 1 hour

export type ImageModel = 'flux-dev' | 'flux-klein' | 'phoenix' | 'lucid-origin';

const IMAGE_MODEL_IDS: Record<ImageModel, string> = {
  'flux-dev':     MODEL_REGISTRY['image-quality'].modelId,
  'flux-klein':   MODEL_REGISTRY['image-fast'].modelId,
  'phoenix':      MODEL_REGISTRY['image-creative'].modelId,
  'lucid-origin': '@cf/leonardo/lucid-origin',
};

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

export function detectImageIntent(text: string): boolean {
  const lower = text.toLowerCase();
  return [...IMAGE_TRIGGERS_ES, ...IMAGE_TRIGGERS_EN].some((kw) => lower.includes(kw));
}

// ─── Generation ──────────────────────────────────────────────────────────────

/**
 * Generate an image using the specified model (defaults to flux-dev),
 * store it in KV, and return its serving URL + model used.
 */
export async function generateImage(
  prompt: string,
  model: ImageModel = 'flux-dev',
  env: Env,
  workerUrl: string,
): Promise<{ url: string; model: string } | null> {
  const modelId = IMAGE_MODEL_IDS[model];
  try {
    const result = await env.AI.run(
      modelId as Parameters<typeof env.AI.run>[0],
      { prompt, num_steps: 4 } as Parameters<typeof env.AI.run>[1],
    );

    const arrayBuffer = await new Response(result as ReadableStream).arrayBuffer();
    if (!arrayBuffer.byteLength) {
      console.warn("[Arcadia] Image generation returned empty buffer for model:", modelId);
      return null;
    }

    const id = crypto.randomUUID();
    await env.ARCADIA_CACHE.put(KV_KEYS.IMG(id), arrayBuffer, { expirationTtl: IMAGE_TTL });

    return { url: `${workerUrl.replace(/\/$/, "")}/api/image/${id}`, model: modelId };
  } catch (err) {
    console.error(`[Arcadia] Image generation failed (${modelId}):`, err);
    // Try fallback model
    const fallback = MODEL_REGISTRY[model === 'flux-dev' ? 'image-quality' : model === 'flux-klein' ? 'image-fast' : 'image-creative'].fallback;
    if (fallback && fallback !== modelId) {
      try {
        const result = await env.AI.run(
          fallback as Parameters<typeof env.AI.run>[0],
          { prompt, num_steps: 4 } as Parameters<typeof env.AI.run>[1],
        );
        const arrayBuffer = await new Response(result as ReadableStream).arrayBuffer();
        if (!arrayBuffer.byteLength) return null;
        const id = crypto.randomUUID();
        await env.ARCADIA_CACHE.put(KV_KEYS.IMG(id), arrayBuffer, { expirationTtl: IMAGE_TTL });
        return { url: `${workerUrl.replace(/\/$/, "")}/api/image/${id}`, model: fallback };
      } catch (fallbackErr) {
        console.error(`[Arcadia] Image fallback (${fallback}) also failed:`, fallbackErr);
      }
    }
    return null;
  }
}

/**
 * Legacy wrapper — used by the pipeline for backward compatibility.
 */
export async function generateAndStoreImage(
  prompt: string,
  env: Env,
  workerUrl: string,
): Promise<{ url: string } | null> {
  const result = await generateImage(prompt, 'flux-dev', env, workerUrl);
  return result ? { url: result.url } : null;
}

// ─── Serving ─────────────────────────────────────────────────────────────────

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
