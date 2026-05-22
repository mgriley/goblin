
export type ElfId = string;

class ChildInfo {
  // TODO
};

export class Elf {
  private children: Map<ElfId, ChildInfo>;

  constructor() {
    this.children = new Map<ElfId, ChildInfo>();
  }

  async runAsRootElf() {
    // TODO
    console.log(`Running root elf!`);
  }

  async run() {
    console.log(`Running an elf!`);

    // Read my purpose.md file. This will be my first instruction.
    // TODO

    // Instruct to start all my child elves
    // TODO
  }

  async spawnChild() {
    // TODO
  }

  async deleteChild(elfId: ElfId) {
    // TODO
  }

  async sendMessage(elfId: ElfId, message: string) {
    // TODO
  }
}
