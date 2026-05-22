import process from "node:process";
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
      const response = await handler(line);
      console.log(response);
    }
    process.stdout.write("> ");
  }
}
