import type { CapabilityDefinition } from "./registry.js";
import { developmentGreetingCapability } from "./registry.js";

const inputSchema = {
  type: "object", additionalProperties: false, required: ["name"],
  properties: { name: { type: "string", minLength: 1, maxLength: 80 } },
};
const outputSchema = {
  type: "object", additionalProperties: false, required: ["message"],
  properties: { message: { type: "string", minLength: 1, maxLength: 256 } },
};

/** A deterministic, local-only tool used to exercise tools-kind registration. */
export function createDevelopmentGreetingExtension(): CapabilityDefinition {
  return {
    manifest: developmentGreetingCapability,
    enabledByDefault: false,
    defaultConfig: {},
    createTools: () => [{
      name: "make_greeting",
      description: "Create a short greeting for the supplied name.",
      inputSchema,
      outputSchema,
      execute(value) {
        const name = typeof value === "object" && value !== null && "name" in value ? String(value.name).trim() : "";
        return { message: `Hello, ${name}.` };
      },
    }],
  };
}
