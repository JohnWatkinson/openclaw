import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";
import { DEFAULT_TIMEOUT_SECONDS, readResponseText, withTimeout } from "./web-shared.js";

const LEONARDO_API_BASE = "https://cloud.leonardo.ai/api/rest/v1";
const POLL_INTERVAL_MS = 2_000;
const POLL_MAX_ATTEMPTS = 30; // 60 seconds total

type LeonardoConfig = NonNullable<NonNullable<OpenClawConfig["tools"]>["leonardo"]>;

type GeneratedImage = {
  id: string;
  url: string;
};

type GenerationResponse = {
  sdGenerationJob?: {
    generationId?: string;
  };
};

type GenerationStatusResponse = {
  generations_by_pk?: {
    status?: string;
    generated_images?: GeneratedImage[];
  };
};

function resolveLeonardoApiKey(config?: OpenClawConfig): string | undefined {
  const fromConfig = (config?.tools as Record<string, unknown> | undefined)
    ?.leonardo as LeonardoConfig | undefined;
  if (fromConfig && typeof fromConfig === "object" && "apiKey" in fromConfig) {
    const key = (fromConfig as { apiKey?: string }).apiKey?.trim();
    if (key) return key;
  }
  return process.env["LEONARDO_API_KEY"]?.trim() || undefined;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollForCompletion(
  generationId: string,
  apiKey: string,
  timeoutSeconds: number,
): Promise<string[]> {
  const maxAttempts = Math.min(
    POLL_MAX_ATTEMPTS,
    Math.floor((timeoutSeconds * 1_000) / POLL_INTERVAL_MS),
  );

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await sleep(POLL_INTERVAL_MS);

    const res = await fetch(`${LEONARDO_API_BASE}/generations/${generationId}`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      signal: withTimeout(undefined, 15_000),
    });

    if (!res.ok) {
      const detail = await readResponseText(res, { maxBytes: 4_000 });
      throw new Error(`Leonardo poll error (${res.status}): ${detail.text || res.statusText}`);
    }

    const data = (await res.json()) as GenerationStatusResponse;
    const generation = data.generations_by_pk;

    if (!generation) {
      throw new Error("Leonardo: unexpected poll response shape");
    }

    if (generation.status === "FAILED") {
      throw new Error("Leonardo generation failed");
    }

    if (generation.status === "COMPLETE") {
      const urls = (generation.generated_images ?? []).map((img) => img.url).filter(Boolean);
      if (urls.length === 0) {
        throw new Error("Leonardo generation complete but no image URLs returned");
      }
      return urls;
    }
    // status === "PENDING" — keep polling
  }

  throw new Error(
    `Leonardo generation timed out after ${maxAttempts * (POLL_INTERVAL_MS / 1000)} seconds`,
  );
}

const LeonardoGenerateImageSchema = Type.Object({
  prompt: Type.String({
    description:
      "Image generation prompt. Be specific about style, mood, lighting, composition, and subject.",
  }),
  num_images: Type.Optional(
    Type.Number({
      description: "Number of images to generate (1-4). Default: 1.",
      minimum: 1,
      maximum: 4,
    }),
  ),
  width: Type.Optional(
    Type.Number({
      description: "Image width in pixels (must be divisible by 8, max 1536). Default: 1024.",
    }),
  ),
  height: Type.Optional(
    Type.Number({
      description: "Image height in pixels (must be divisible by 8, max 1536). Default: 1024.",
    }),
  ),
  preset_style: Type.Optional(
    Type.String({
      description:
        "Visual style preset. Options: FASHION, PHOTOGRAPHY, PORTRAIT, CINEMATIC, CREATIVE. Default: FASHION.",
    }),
  ),
});

export function createLeonardoTool(options?: { config?: OpenClawConfig }): AnyAgentTool | null {
  const apiKey = resolveLeonardoApiKey(options?.config);
  if (!apiKey) {
    return null;
  }

  return {
    label: "Generate Image",
    name: "generate_image",
    description:
      "Generate reference images using Leonardo.ai. Use this to create mood board images, visual references for shoots, or creative concept images. Returns image URLs that can be sent to Telegram.",
    parameters: LeonardoGenerateImageSchema,
    execute: async (_toolCallId, args) => {
      try {
        const params = args as Record<string, unknown>;
        const prompt = readStringParam(params, "prompt", { required: true });
        const numImages = (params["num_images"] as number | undefined) ?? 1;
        const width = (params["width"] as number | undefined) ?? 1024;
        const height = (params["height"] as number | undefined) ?? 1024;
        const presetStyle = readStringParam(params, "preset_style") ?? "FASHION";

        const body = {
          prompt,
          num_images: numImages,
          width,
          height,
          presetStyle,
        };

        const res = await fetch(`${LEONARDO_API_BASE}/generations`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(body),
          signal: withTimeout(undefined, DEFAULT_TIMEOUT_SECONDS * 1_000),
        });

        if (!res.ok) {
          const detail = await readResponseText(res, { maxBytes: 4_000 });
          throw new Error(
            `Leonardo generation request failed (${res.status}): ${detail.text || res.statusText}`,
          );
        }

        const data = (await res.json()) as GenerationResponse;
        const generationId = data.sdGenerationJob?.generationId;

        if (!generationId) {
          throw new Error("Leonardo: no generationId in response");
        }

        const imageUrls = await pollForCompletion(generationId, apiKey, 60);

        return jsonResult({
          generationId,
          imageUrls,
          count: imageUrls.length,
        });
      } catch (error) {
        return jsonResult({
          error: error instanceof Error ? error.message : String(error),
          imageUrls: [],
        });
      }
    },
  };
}
