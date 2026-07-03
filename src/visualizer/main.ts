import { startVisualizerServer } from "./server.js";

const inputPath = process.argv[2];
if (!inputPath) {
  console.error(
    "visualizer/main: pass a recording (.jsonl) file, or a goblin root / recordings dir",
  );
  process.exit(1);
}

startVisualizerServer(inputPath).catch((err) => {
  console.error(`visualizer/main: ${(err as Error).message}`);
  process.exit(1);
});
