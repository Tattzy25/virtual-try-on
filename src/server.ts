import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

export interface Env {
  OPENAI_API_KEY: string;
  BUCKET: R2Bucket;
}

async function resolveImage(input: string): Promise<{ blob: Blob; filename: string }> {
  // data URI: data:image/png;base64,.... or data:image/jpeg;base64,....
  if (input.startsWith("data:")) {
    const match = input.match(/^data:([^;]+);base64,(.*)$/);
    const mimeType = match[1];
    const ext = mimeType.split("/")[1]?.split("+")[0] || "png";
    const bytes = atob(match[2]);
    const buf = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) buf[i] = bytes.charCodeAt(i);
    const blob = new Blob([buf], { type: mimeType });
    return { blob, filename: `input-${Math.random().toString(36).slice(2)}.${ext}` };
  }

  // raw base64 string (no data URI prefix) — assume png if we can't detect
  const looksLikeBase64 = /^[A-Za-z0-9+/=\s]+$/.test(input.slice(0, 200)) && input.length > 200;
  if (looksLikeBase64) {
    const clean = input.replace(/\s/g, "");
    const bytes = atob(clean);
    const buf = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) buf[i] = bytes.charCodeAt(i);
    const blob = new Blob([buf], { type: "image/png" });
    return { blob, filename: `input-${Math.random().toString(36).slice(2)}.png` };
  }

  // URL — fetch it
  const response = await fetch(input);
  const blob = await response.blob();
  const ext = blob.type.split("/")[1]?.split("+")[0] || "png";
  return { blob, filename: `input-${Math.random().toString(36).slice(2)}.${ext}` };
}

function createServer(env: Env) {
  const server = new McpServer({
    name: "Virtual Try On",
    version: "1.0.0"
  });

  server.registerTool(
    "virtual_try_on",
    {
      description: "returns a image or possibly multiple images that were generated",
      inputSchema: {
        images: z
          .array(z.string())
          .min(2)
          .max(3)
          .describe("2 or 3 images: the person photo and the garment/suit photo(s). Accepts image URLs, base64 data URIs, or raw base64 strings."),
        prompt: z
          .string()
          .describe("The edit instructions for the image generation."),
      }
    },
    async ({ images, prompt }) => {
      const formData = new FormData();
      for (const img of images) {
        const { blob, filename } = await resolveImage(img);
        formData.append("image[]", blob, filename);
      }
      formData.append("prompt", prompt);
      formData.append("model", "gpt-image-2.5-sunburst");
      formData.append("n", "1");
      formData.append("size", "1024x1024");
      formData.append("quality", "medium");
      formData.append("background", "auto");
      formData.append("moderation", "low");

      const response = await fetch("https://api.openai.com/v1/images/edits", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        },
        body: formData,
      });

      const result = await response.json() as {
        data: Array<{ b64_json?: string; url?: string }>;
      };

      const urls: string[] = [];

      for (const item of result.data ?? []) {
        if (item.b64_json) {
          const bytes = atob(item.b64_json);
          const buf = new Uint8Array(bytes.length);
          for (let i = 0; i < bytes.length; i++) buf[i] = bytes.charCodeAt(i);
          const key = `tryon-${Date.now()}-${Math.random().toString(36).slice(2)}.png`;
          await env.BUCKET.put(key, buf, {
            httpMetadata: {
              contentType: "image/png",
              contentDisposition: "inline",
            },
          });
          urls.push(`https://virtual-tryon-bucket.anigok.com/${key}`);
        } else if (item.url) {
          urls.push(item.url);
        }
      }

      return {
        content: [
          {
            type: "text",
            text: urls.join("\n"),
          }
        ]
      };
    }
  );

  server.registerTool(
    "upload_image",
    {
      description: "Uploads 1 or more images to the R2 bucket and returns the public URLs. Accepts base64 data URIs, raw base64, or image URLs. Returns only the URLs, nothing else.",
      inputSchema: {
        images: z
          .array(z.string())
          .min(1)
          .max(10)
          .describe("1 to 10 images: base64 data URIs (data:image/...;base64,...), raw base64 strings, or image URLs."),
      }
    },
    async ({ images }) => {
      const urls: string[] = [];
      for (const img of images) {
        const { blob } = await resolveImage(img);
        const ext = blob.type.split("/")[1]?.split("+")[0] || "png";
        const key = `uploads/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
        const buf = new Uint8Array(await blob.arrayBuffer());
        await env.BUCKET.put(key, buf, {
          httpMetadata: {
            contentType: blob.type || "image/png",
            contentDisposition: "inline",
          },
        });
        urls.push(`https://virtual-tryon-bucket.anigok.com/${key}`);
      }
      return {
        content: [
          {
            type: "text",
            text: urls.join("\n"),
          }
        ]
      };
    }
  );

  return server;
}

export default {
  fetch(request, env, ctx) {
    return createMcpHandler(() => createServer(env))(request, env, ctx);
  }
} satisfies ExportedHandler<Env>;
