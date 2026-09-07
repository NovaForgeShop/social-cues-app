import path from "node:path";

export const launchPromoAssets = [
  { id: "square-feed", platformFit: ["x", "threads", "facebook_feed", "instagram_feed"], fileName: "social-cues-coming-soon-square-feed-1080x1080.mp4", kind: "video", contentType: "video/mp4" },
  { id: "vertical-9x16", platformFit: ["instagram", "facebook", "tiktok", "youtube"], fileName: "social-cues-coming-soon-vertical-9x16-1080x1920.mp4", kind: "video", contentType: "video/mp4" },
  { id: "story-safe", platformFit: ["instagram_story", "facebook_story"], fileName: "social-cues-coming-soon-story-safe-1080x1920.mp4", kind: "video", contentType: "video/mp4" },
  { id: "square-still", platformFit: ["x", "threads", "facebook_feed", "instagram_feed"], fileName: "social-cues-coming-soon-square-still-1080x1080.png", kind: "image", contentType: "image/png" },
  { id: "vertical-still", platformFit: ["instagram", "facebook", "tiktok"], fileName: "social-cues-coming-soon-vertical-still-1080x1920.png", kind: "image", contentType: "image/png" },
  { id: "youtube-thumbnail", platformFit: ["youtube"], fileName: "social-cues-coming-soon-youtube-thumbnail-1280x720.png", kind: "image", contentType: "image/png" }
];

function publicMediaAssetUrl(fileName, brandHomeUrl) {
  return `${brandHomeUrl}/media/social-cues-promo-pack/${encodeURIComponent(fileName)}`;
}

export function publicMediaContentType(fileName) {
  const ext = path.extname(fileName).toLowerCase();
  if (ext === ".mp4") return "video/mp4";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  return "application/octet-stream";
}

export function publicLaunchPromoAssets(brandHomeUrl) {
  return launchPromoAssets.map(asset => ({
    ...asset,
    url: publicMediaAssetUrl(asset.fileName, brandHomeUrl),
    metaPullReady: true,
    note: "Public HTTPS asset. Safe for Meta, TikTok, YouTube, X, and Threads pull-by-URL checks."
  }));
}
