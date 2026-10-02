import { Type, type TSchema } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";

export interface WorkbenchToolAdapterInput {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute(input: unknown, signal?: AbortSignal): Promise<unknown> | unknown;
}

/**
 * The only PI-specific extension-tool bridge. Workbench packages provide
 * already-authorized tools and receive no PI SDK objects or discovery access.
 */
export function adaptWorkbenchToolsToPi(tools: WorkbenchToolAdapterInput[]): ToolDefinition[] {
  const names = new Set<string>();
  return tools.map((tool) => {
    if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(tool.name) || names.has(tool.name) || !tool.description.trim()) {
      throw new TypeError("Workbench tool registration is invalid");
    }
    names.add(tool.name);
    return defineTool({
      name: tool.name,
      label: tool.name,
      description: tool.description.slice(0, 512),
      parameters: Type.Unsafe<TSchema>(tool.inputSchema),
      async execute(_toolCallId, input, signal) {
        const output = await tool.execute(input, signal);
        const text = JSON.stringify(output);
        if (text === undefined || Buffer.byteLength(text, "utf8") > 8192) throw new Error("Extension tool output exceeded its adapter limit");
        return { content: [{ type: "text", text }], details: output };
      },
    });
  });
}
