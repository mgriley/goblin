import process from "node:process";

import { Elf, type ElfConfig } from "./elf.js";

const elf = new Elf();

if (process.send) {
  // We were forked by a parent elf — wait for its startup message.
  const { config, elfDir } = await new Promise<{
    config: ElfConfig;
    elfDir: string;
  }>((resolve) => {
    process.once("message", (msg) =>
      resolve(msg as { config: ElfConfig; elfDir: string }),
    );
  });
  await elf.run(config, elfDir);
} else {
  console.log(`Awakening the army...`);
  await elf.runRootElf();
}
