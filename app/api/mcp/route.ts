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

/**
 * Finds a WordPress category or tag by name (case-insensitive exact match).
 * If it doesn't exist, creates it. Returns the term ID, or null on failure.
 */
async function getOrCreateTermId(
  type: "categories" | "tags",
  name: string,
  siteUrl: string,
  authHeader: string,
): Promise<number | null> {
  const trimmedName = name.trim();
  if (!trimmedName) return null;

  try {
    // 1. Search for an existing term with this name
    const searchRes = await fetch(
      `${siteUrl}/wp-json/wp/v2/${type}?search=${encodeURIComponent(trimmedName)}&per_page=20`,
      { headers: { Authorization: `Basic ${authHeader}` } },
    );

    if (searchRes.ok) {
      const results = await searchRes.json();
      const exactMatch = Array.isArray(results)
        ? results.find(
            (t: any) =>
              t?.name?.trim().toLowerCase() === trimmedName.toLowerCase(),
          )
        : null;
      if (exactMatch) return exactMatch.id;
    }

    // 2. Not found — create it
    const createRes = await fetch(`${siteUrl}/wp-json/wp/v2/${type}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${authHeader}`,
      },
      body: JSON.stringify({ name: trimmedName }),
    });

    if (createRes.ok) {
      const created = await createRes.json();
      return created.id;
    }

    // 3. Handle race condition: term was created between our search and create
    const createErr = await createRes.json().catch(() => null);
    if (createErr?.code === "term_exists" && createErr?.data?.term_id) {
      return createErr.data.term_id;
    }

    console.warn(
      `[${type}] Failed to find or create "${trimmedName}": ${JSON.stringify(createErr)}`,
    );
    return null;
  } catch (e: unknown) {
    console.warn(`[${type}] Error resolving "${trimmedName}": ${errMsg(e)}`);
    return null;
  }
}

const handler = createMcpHandler((server) => {
  server.registerTool(
    "publish_post",
    {
      title:
        "Publish Hindi SEO News Post with Category/Tag Auto-Match and 3-Tier Image Fallback",
      description:
        "Publish an article LIVE (auto-published, never a draft) to littichokhanews.com. ALL text fields (title, content, excerpt) MUST be written in Hindi (Devanagari script) — never English. Automatically matches the article to an existing WordPress category by name, creating a new one only if no close match exists. Automatically matches or creates relevant tags the same way. Handles images automatically via URL, Gemini 2.5 Flash Image (Nano Banana), or Pollinations.",
      inputSchema: z.object({
        title: z
          .string()
          .describe(
            "Highly compelling, click-worthy headline IN HINDI (Devanagari script). 50-65 characters.",
          ),
        content: z
          .string()
          .describe("The HTML article content, written entirely IN HINDI."),
        excerpt: z
          .string()
          .describe(
            "A compelling meta description IN HINDI. Max 160 characters.",
          ),
        category_name: z
          .string()
          .describe(
            "The single most relevant category for this article, e.g. 'व्यापार', 'राजनीति', 'खेल', 'मनोरंजन', 'तकनीक'. Reuse an existing site category whenever the topic fits one — only propose a new category name if nothing existing is a reasonable match. This will be looked up on the site and created automatically if it doesn't exist.",
          ),
        tag_names: z
          .array(z.string())
          .min(1)
          .max(8)
          .describe(
            "3-8 relevant tags in Hindi for this specific article (people, places, organizations, specific topics mentioned). Reuse existing tags where they fit; new ones are created automatically if they don't exist yet.",
          ),
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
      }),
    },
    async ({
      title,
      content,
      excerpt,
      category_name,
      tag_names,
      featured_image_url,
      image_prompt,
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
        // RESOLVE CATEGORY & TAGS (find existing, else create)
        // ==========================================
        console.log(`[Taxonomy] Resolving category: ${category_name}`);
        const categoryId = await getOrCreateTermId(
          "categories",
          category_name,
          WP_SITE_URL,
          auth,
        );

        console.log(
          `[Taxonomy] Resolving ${tag_names.length} tag(s): ${tag_names.join(", ")}`,
        );
        const tagIdResults = await Promise.all(
          tag_names.map((t) => getOrCreateTermId("tags", t, WP_SITE_URL, auth)),
        );
        const tagIds = tagIdResults.filter((id): id is number => id !== null);

        // ==========================================
        // PUBLISH THE ARTICLE
        // ==========================================
        const postPayload: Record<string, unknown> = {
          title,
          content,
          excerpt,
          status: "publish", // Always auto-publish — not agent-controllable
        };
        if (featured_media_id !== null) {
          postPayload.featured_media = featured_media_id;
        }
        if (categoryId !== null) {
          postPayload.categories = [categoryId];
        }
        if (tagIds.length > 0) {
          postPayload.tags = tagIds;
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

  server.registerTool(
    "get_recent_posts",
    {
      title: "Get Recent Post Titles (Duplicate Check)",
      description:
        "Fetch the titles and categories of the most recently published posts on littichokhanews.com. ALWAYS call this FIRST before researching a new article topic, so you can avoid writing about a story that was already covered today.",
      inputSchema: z.object({
        count: z
          .number()
          .min(1)
          .max(20)
          .default(10)
          .describe("How many recent posts to check (default 10)."),
      }),
    },
    async ({ count }) => {
      if (!WP_SITE_URL || !WP_USERNAME || !WP_APP_PASSWORD) {
        return {
          content: [{ type: "text", text: "Error: Missing WP credentials." }],
          isError: true,
        };
      }
      const auth = Buffer.from(`${WP_USERNAME}:${WP_APP_PASSWORD}`).toString(
        "base64",
      );
      try {
        const res = await fetch(
          `${WP_SITE_URL}/wp-json/wp/v2/posts?per_page=${count}&_fields=title,date,link,categories`,
          { headers: { Authorization: `Basic ${auth}` } },
        );
        if (!res.ok) {
          return {
            content: [
              {
                type: "text",
                text: `Failed to fetch recent posts: ${await res.text()}`,
              },
            ],
            isError: true,
          };
        }
        const posts = await res.json();
        const summary = posts
          .map(
            (p: any) =>
              `- "${p.title?.rendered ?? "(untitled)"}" (published: ${p.date})`,
          )
          .join("\n");
        return {
          content: [
            {
              type: "text",
              text: summary || "No recent posts found.",
            },
          ],
        };
      } catch (e: unknown) {
        return {
          content: [{ type: "text", text: `Error: ${errMsg(e)}` }],
          isError: true,
        };
      }
    },
  );
});

export { handler as GET, handler as POST, handler as DELETE };
