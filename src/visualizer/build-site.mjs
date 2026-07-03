import { buildSite } from "../../scripts/build-site.mjs";

// `--dev` bundles beside the source for `tsx` runs; otherwise into dist/.
await buildSite(import.meta.url, { dev: process.argv.includes("--dev") });
