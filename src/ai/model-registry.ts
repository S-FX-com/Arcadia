// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Model Registry (Phase 10)
//
// Centralised model routing config. Replaces scattered CF_AI_DEFAULT_MODEL
// references so model tuning only requires a single file (or env var override).
// ─────────────────────────────────────────────────────────────────────────────

import type { Env } from "../types.js";

export type ModelPurpose =
  | 'quick-chat'
  | 'deep-research'
  | 'coding'
  | 'client-indexing'
  | 'memory-extraction'
  | 'summarization'
  | 'image-quality'
  | 'image-fast'
  | 'image-creative'
  | 'embeddings'
  // Phase 2 — agent loop with native function calling on Workers AI.
  | 'agent-tool-use';

export interface ModelConfig {
  modelId: string;
  fallback?: string;
  maxTokens: number;
  useAdvisor: boolean;
  advisorTriggers?: string[];
}

export const MODEL_REGISTRY: Record<ModelPurpose, ModelConfig> = {
  'quick-chat': {
    modelId: '@cf/google/gemma-4-27b-it',
    maxTokens: 2048,
    useAdvisor: false,
  },
  'deep-research': {
    modelId: '@cf/google/gemma-4-27b-it',
    fallback: '@cf/meta/llama-4-scout-17b-16e-instruct',
    maxTokens: 8192,
    useAdvisor: true,
    advisorTriggers: [
      'conflicting information',
      'complex multi-source analysis',
      'strategic recommendation',
      'cross-client pattern detection',
    ],
  },
  'coding': {
    modelId: '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b',
    fallback: '@cf/google/gemma-4-27b-it',
    maxTokens: 4096,
    useAdvisor: true,
    advisorTriggers: [
      'architectural decision',
      'security consideration',
      'performance trade-off',
    ],
  },
  'client-indexing': {
    modelId: '@cf/google/gemma-4-27b-it',
    maxTokens: 4096,
    useAdvisor: false,
  },
  'memory-extraction': {
    modelId: '@cf/google/gemma-4-27b-it',
    maxTokens: 1024,
    useAdvisor: false,
  },
  'summarization': {
    modelId: '@cf/google/gemma-4-27b-it',
    maxTokens: 2048,
    useAdvisor: false,
  },
  'image-quality': {
    modelId: '@cf/black-forest-labs/flux-2-dev',
    fallback: '@cf/leonardo/phoenix-1.0',
    maxTokens: 0,
    useAdvisor: false,
  },
  'image-fast': {
    modelId: '@cf/black-forest-labs/flux-2-klein',
    fallback: '@cf/bytedance/stable-diffusion-xl-lightning',
    maxTokens: 0,
    useAdvisor: false,
  },
  'image-creative': {
    modelId: '@cf/leonardo/phoenix-1.0',
    fallback: '@cf/leonardo/lucid-origin',
    maxTokens: 0,
    useAdvisor: false,
  },
  'embeddings': {
    modelId: '@cf/baai/bge-base-en-v1.5',
    maxTokens: 0,
    useAdvisor: false,
  },
  // Phase 2 — primary tool-using agent. llama-3.3-70b-instruct-fp8-fast
  // supports OpenAI-style function calling on Workers AI. Hermes-2-Pro
  // is the smaller fallback when the primary model is rate-limited.
  'agent-tool-use': {
    modelId: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    fallback: '@hf/nousresearch/hermes-2-pro-mistral-7b',
    maxTokens: 4096,
    useAdvisor: false,
  },
};

/** Env var name overrides per purpose, e.g. MODEL_QUICK_CHAT, MODEL_DEEP_RESEARCH */
const ENV_OVERRIDES: Partial<Record<ModelPurpose, keyof Env>> = {
  'quick-chat': 'MODEL_QUICK_CHAT',
  'deep-research': 'MODEL_DEEP_RESEARCH',
  'coding': 'MODEL_CODING',
};

export function getModel(purpose: ModelPurpose, env: Env): ModelConfig {
  const overrideKey = ENV_OVERRIDES[purpose];
  if (overrideKey) {
    const override = env[overrideKey] as string | undefined;
    if (override) {
      return { ...MODEL_REGISTRY[purpose], modelId: override };
    }
  }
  return MODEL_REGISTRY[purpose];
}
