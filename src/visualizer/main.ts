import { startVisualizerServer } from "./server.js";

const recordingFile = process.argv[2];
if (!recordingFile) {
  console.error("visualizer/main: path to a recording (.jsonl) file required");
  process.exit(1);
}

startVisualizerServer(recordingFile);
