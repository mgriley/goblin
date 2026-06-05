import process from "node:process";

import { Elf, type ElfConfig } from "./elf.js";

const elf = new Elf();

if (process.send) {
  // We were forked by a parent elf — wait for its startup message.
  const { config, elfDir, purpose } = await new Promise<{
    config: ElfConfig;
    elfDir: string;
    purpose?: string;
  }>((resolve) => {
    process.once("message", (msg) =>
      resolve(msg as { config: ElfConfig; elfDir: string; purpose?: string }),
    );
  });
  await elf.run(config, elfDir, purpose);
} else {
  console.log(`Awakening the army...`);
  await elf.runRootElf();
}
