import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { z } from "zod";

import type { Tool } from "./llm.js";

const execFileAsync = promisify(execFile);

const RunBashCommandArgsSchema = z.object({
  name: z.string(),
  args: z.string().default(""),
});

export const runBashCommandTool: Tool = {
  name: "run_bash_command",
  description:
    "Run a single CLI tool (e.g. `ls`, `cat`, `grep`) in the elf's working " +
    "directory. Provide the tool's name and an args string.",
  parameters: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: 'The CLI tool to invoke (e.g. "ls", "cat", "grep").',
      },
      args: {
        type: "string",
        description: 'Arguments as a single string (e.g. "-la /tmp"). May be empty.',
      },
    },
    required: ["name"],
  },
  handler: async (rawArgs) => {
    const { name, args } = RunBashCommandArgsSchema.parse(rawArgs);
    const command = args ? `${name} ${args}` : name;
    try {
      const { stdout, stderr } = await execFileAsync("bash", ["-c", command]);
      return formatBashResult(0, stdout, stderr);
    } catch (err) {
      const e = err as {
        stdout?: string;
        stderr?: string;
        code?: number | null;
      };
      return formatBashResult(e.code ?? null, e.stdout ?? "", e.stderr ?? "");
    }
  },
};

function formatBashResult(
  code: number | null,
  stdout: string,
  stderr: string,
): string {
  const parts: string[] = [`exit code: ${code ?? "?"}`];
  if (stdout) parts.push(`stdout:\n${stdout}`);
  if (stderr) parts.push(`stderr:\n${stderr}`);
  return parts.join("\n");
}
