// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Image Generation API (Phase 10)
//
// POST /api/webapp/images/generate   — generate image from prompt
// GET  /api/webapp/images/:id        — retrieve generated image from KV
// ─────────────────────────────────────────────────────────────────────────────

import type { Env } from "../../types.js";
import type { WebappSession } from "../types.js";
import { jsonResponse, errorResponse } from "../middleware.js";
import { generateImage, serveStoredImage, type ImageModel } from "../../ai/image.js";

const IMAGE_MODEL_MAP: Record<string, ImageModel> = {
  quality: 'flux-dev',
  fast: 'flux-klein',
  creative: 'phoenix',
};

export async function handleImagesAPI(
  request: Request,
  url: URL,
  session: WebappSession,
  env: Env,
): Promise<Response | null> {
  const path = url.pathname;
  const method = request.method;

  // POST /api/webapp/images/generate
  if (path === '/api/webapp/images/generate' && method === 'POST') {
    let body: { prompt?: string; model?: string };
    try { body = await request.json() as typeof body; } catch { return errorResponse('Invalid JSON', 400); }
    if (!body.prompt?.trim()) return errorResponse('prompt is required', 400);

    const modelKey = body.model ?? 'quality';
    const imageModel: ImageModel = IMAGE_MODEL_MAP[modelKey] ?? 'flux-dev';
    const workerUrl = new URL(request.url).origin;

    const result = await generateImage(body.prompt.trim(), imageModel, env, workerUrl);
    if (!result) {
      return errorResponse('Image generation failed', 502);
    }

    return jsonResponse({ url: result.url, model: result.model, prompt: body.prompt.trim() });
  }

  // GET /api/webapp/images/:id — proxy to the KV-stored image
  const imgMatch = path.match(/^\/api\/webapp\/images\/([a-f0-9-]{36})$/);
  if (imgMatch && imgMatch[1] && method === 'GET') {
    const img = await serveStoredImage(imgMatch[1], env);
    if (!img) return errorResponse('Image not found or expired', 404);
    return img;
  }

  return null;
}
