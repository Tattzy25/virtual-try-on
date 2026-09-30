import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

export interface Env {
  OPENAI_API_KEY: string;
  BUCKET: R2Bucket;
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
          .describe("2 or 3 image URLs: the person photo and the garment/suit photo(s)."),
        prompt: z
          .string()
          .describe("The edit instructions for the image generation."),
      }
    },
    async ({ images, prompt }) => {
      const formData = new FormData();
      for (const img of images) {
        const response = await fetch(img);
        const blob = await response.blob();
        const ext = blob.type.split("/")[1]?.split("+")[0] || "png";
        formData.append("image[]", blob, `input-${Math.random().toString(36).slice(2)}.${ext}`);
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

  return server;
}

export default {
  fetch(request, env, ctx) {
    return createMcpHandler(() => createServer(env))(request, env, ctx);
  }
} satisfies ExportedHandler<Env>;
