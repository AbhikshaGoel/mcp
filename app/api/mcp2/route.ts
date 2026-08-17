import { createMcpHandler } from "mcp-handler";
import { z } from "zod";

const WP_SITE_URL = process.env.WP_SITE_URL;
const WP_USERNAME = process.env.WP_USERNAME;
const WP_APP_PASSWORD = process.env.WP_APP_PASSWORD;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const POLLINATIONS_API_KEY = process.env.POLLINATIONS_API_KEY;

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const handler = createMcpHandler((server) => {
  server.registerTool(
    "publish_post_old",
    {
      title: "Publish SEO News Post with 3-Tier Image Fallback",
      description:
        "Publish an article in Hindi on littichokhanews.com. Handles images automatically via URL, Gemini 2.5 Flash Image (Nano Banana), or Pollinations.",
      inputSchema: z.object({
        title: z
          .string()
          .describe(
            "Highly compelling, click-worthy headline. 50-65 characters.",
          ),
        content: z.string().describe("The HTML article content."),
        excerpt: z
          .string()
          .describe("A compelling meta description. Max 160 characters."),
        featured_image_url: z
          .string()
          .url()
          .optional()
          .describe(
            "TIER 1: Direct URL to a real public image online. USE THIS FIRST if you find a relevant news photo.",
          ),
        image_prompt: z
          .string()
          .optional()
          .describe(
            "TIER 2 & 3: ONLY USE IF NO URL IS FOUND. Provide a highly detailed visual description for AI generation.",
          ),
        status: z.enum(["publish", "draft"]).default("publish"),
      }),
    },
    async ({
      title,
      content,
      excerpt,
      featured_image_url,
      image_prompt,
      status,
    }) => {
      if (!WP_SITE_URL || !WP_USERNAME || !WP_APP_PASSWORD) {
        return {
          content: [{ type: "text", text: "Error: Missing WP credentials." }],
          isError: true,
        };
      }

      const auth = Buffer.from(`${WP_USERNAME}:${WP_APP_PASSWORD}`).toString(
        "base64",
      );
      let featured_media_id: number | null = null;
      let imageBuffer: Buffer | null = null;
      let mimeType = "image/jpeg";
      let ext = "jpg";

      try {
        // ==========================================
        // TIER 1: Gemini Spark found a Real URL
        // ==========================================
        if (featured_image_url) {
          console.log(
            `[Tier 1] Downloading real image from URL: ${featured_image_url}`,
          );
          try {
            const imgResponse = await fetch(featured_image_url);
            if (imgResponse.ok) {
              imageBuffer = Buffer.from(await imgResponse.arrayBuffer());
              mimeType =
                imgResponse.headers.get("content-type") || "image/jpeg";
              ext = mimeType.split("/")[1] || "jpg";
            } else {
              throw new Error(`Failed to download URL: ${imgResponse.status}`);
            }
          } catch (e: unknown) {
            console.warn(
              `[Tier 1] Failed (${errMsg(e)}). Falling back to AI generation...`,
            );
          }
        }

        // ==========================================
        // TIER 2: Gemini 2.5 Flash Image ("Nano Banana")
        // Imagen model endpoints are deprecated as of Aug 17, 2026 —
        // Google's current guidance is to use generateContent with
        // gemini-2.5-flash-image instead of generateImages + Imagen.
        // ==========================================
        if (!imageBuffer && image_prompt && GEMINI_API_KEY) {
          console.log(
            `[Tier 2] Generating via Gemini 2.5 Flash Image (Nano Banana). Prompt: ${image_prompt}`,
          );
          try {
            const nanoBananaRes = await fetch(
              `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent`,
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "x-goog-api-key": GEMINI_API_KEY,
                },
                body: JSON.stringify({
                  contents: [
                    {
                      parts: [{ text: image_prompt }],
                    },
                  ],
                }),
              },
            );

            if (nanoBananaRes.ok) {
              const nbData = await nanoBananaRes.json();
              const parts = nbData?.candidates?.[0]?.content?.parts ?? [];
              const imagePart = parts.find((p: any) => p?.inlineData?.data);

              if (imagePart) {
                imageBuffer = Buffer.from(imagePart.inlineData.data, "base64");
                mimeType = imagePart.inlineData.mimeType || "image/png";
                ext = mimeType.split("/")[1] || "png";
              } else {
                throw new Error(
                  "Nano Banana returned OK but no image data found in response parts.",
                );
              }
            } else {
              throw new Error(
                `Nano Banana API Error: ${await nanoBananaRes.text()}`,
              );
            }
          } catch (e: unknown) {
            console.warn(
              `[Tier 2] Nano Banana failed: ${errMsg(e)}. Falling back to Pollinations...`,
            );
          }
        }

        // ==========================================
        // TIER 3: Pollinations.ai (FLUX.1 Schnell Fallback)
        // Pollinations now requires an API key on all generation
        // requests (get one from enter.pollinations.ai).
        // ==========================================
        if (!imageBuffer && image_prompt) {
          console.log(
            `[Tier 3] Generating via Pollinations.ai (flux/schnell). Prompt: ${image_prompt}`,
          );
          try {
            const pollinationsUrl = `https://gen.pollinations.ai/image/${encodeURIComponent(image_prompt)}?model=flux`;
            const pollinationsRes = await fetch(pollinationsUrl, {
              headers: POLLINATIONS_API_KEY
                ? { Authorization: `Bearer ${POLLINATIONS_API_KEY}` }
                : {},
            });

            if (pollinationsRes.ok) {
              imageBuffer = Buffer.from(await pollinationsRes.arrayBuffer());
              mimeType =
                pollinationsRes.headers.get("content-type") || "image/jpeg";
              ext = mimeType.split("/")[1] || "jpg";
            } else {
              console.error(
                `[Tier 3] Pollinations failed: ${await pollinationsRes.text()}`,
              );
            }
          } catch (e: unknown) {
            console.error(`[Tier 3] Fatal image error: ${errMsg(e)}`);
          }
        }

        // ==========================================
        // UPLOAD IMAGE TO WORDPRESS
        // ==========================================
        if (imageBuffer) {
          const mediaUploadRes = await fetch(
            `${WP_SITE_URL}/wp-json/wp/v2/media`,
            {
              method: "POST",
              headers: {
                "Content-Type": mimeType,
                "Content-Disposition": `attachment; filename="news-image-${Date.now()}.${ext}"`,
                Authorization: `Basic ${auth}`,
              },
              body: new Uint8Array(imageBuffer),
            },
          );

          if (mediaUploadRes.ok) {
            const mediaData = await mediaUploadRes.json();
            featured_media_id = mediaData.id;
            console.log(
              `Successfully uploaded image to WP! Media ID: ${featured_media_id}`,
            );
          } else {
            console.warn(
              `[Media Upload] Failed: ${await mediaUploadRes.text()}`,
            );
          }
        }

        // ==========================================
        // PUBLISH THE ARTICLE
        // ==========================================
        const postPayload: Record<string, unknown> = {
          title,
          content,
          excerpt,
          status,
        };
        if (featured_media_id !== null) {
          postPayload.featured_media = featured_media_id;
        }

        const response = await fetch(`${WP_SITE_URL}/wp-json/wp/v2/posts`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Basic ${auth}`,
          },
          body: JSON.stringify(postPayload),
        });

        const data = await response.json();

        if (!response.ok) {
          return {
            content: [
              {
                type: "text",
                text: `Failed to publish: ${JSON.stringify(data)}`,
              },
            ],
            isError: true,
          };
        }

        return {
          content: [
            {
              type: "text",
              text: `Successfully published! Live URL: ${data.link}`,
            },
          ],
        };
      } catch (error: unknown) {
        return {
          content: [{ type: "text", text: `Error: ${errMsg(error)}` }],
          isError: true,
        };
      }
    },
  );
});

export { handler as GET, handler as POST, handler as DELETE };
