import { build } from "esbuild";
import { mkdir, copyFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Bundle a tool's browser frontend (`site/app.ts` → `app.js`) with esbuild.
 * Called by each tool's own `build-site.mjs` so the logic lives in one place.
 *
 * @param {string} moduleUrl  `import.meta.url` of the caller — locates its
 *   tool dir (e.g. `src/inspector`).
 * @param {{ dev?: boolean }} [opts]  In dev, emit `app.js` beside the source so
 *   `tsx` serves it directly. Otherwise emit into `dist/<tool>/site` and copy
 *   `index.html` alongside it (a clean, source-free static bundle).
 */
export async function buildSite(moduleUrl, { dev = false } = {}) {
  const toolDir = path.dirname(fileURLToPath(moduleUrl)); // src/<tool>
  const tool = path.basename(toolDir);
  const root = path.resolve(toolDir, "..", "..");
  const siteSrc = path.join(toolDir, "site");
  const outSite = dev ? siteSrc : path.join(root, "dist", tool, "site");

  await mkdir(outSite, { recursive: true });
  await build({
    entryPoints: [path.join(siteSrc, "app.ts")],
    bundle: true,
    format: "esm",
    outfile: path.join(outSite, "app.js"),
  });
  if (!dev) {
    await copyFile(path.join(siteSrc, "index.html"), path.join(outSite, "index.html"));
  }
}
