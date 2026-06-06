import process from "node:process";
import { clearLine, moveCursor } from "node:readline";
import { createInterface } from "node:readline/promises";

/**
 * Run a simple line-based REPL: read a line of stdin, await `handler(line)`,
 * print the result, repeat. Resolves when stdin closes (Ctrl-D / EOF).
 */
export async function runCli(
  handler: (message: string) => Promise<string>,
): Promise<void> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  process.stdout.write("> ");
  for await (const line of rl) {
    if (line.trim()) {
      // Overwrite the plain readline echo with a bold cyan version.
      moveCursor(process.stdout, 0, -1);
      clearLine(process.stdout, 0);
      process.stdout.write(`\x1b[1;36m> ${line}\x1b[0m\n\n`);
      const response = await handler(line);
      console.log(response + "\n");
    }
    process.stdout.write("> ");
  }
}
