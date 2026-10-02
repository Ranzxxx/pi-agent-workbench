import { Type, type Static } from "typebox";
import { Check } from "typebox/value";

const object = <T extends Record<string, import("typebox").TSchema>>(properties: T) => Type.Object(properties, { additionalProperties: false });
const id = Type.String({ minLength: 1, maxLength: 128, pattern: "^[a-zA-Z0-9_-]+$" });
const boundedJsonObject = Type.Record(Type.String({ minLength: 1, maxLength: 128 }), Type.Any(), { maxProperties: 64 });

/** A bounded JSON Schema subset carried as data; the workbench validates and executes it without eval. */
export const ExtensionJsonSchemaSchema = Type.Record(Type.String({ minLength: 1, maxLength: 64 }), Type.Any(), { maxProperties: 32 });
export type ExtensionJsonSchema = Record<string, unknown>;

export const CapabilityPermissionSchema = Type.Union([
  Type.Literal("public_repository.read"), Type.Literal("project.read"), Type.Literal("project.write"),
  Type.Literal("attachments.read"), Type.Literal("results.write"),
]);

export const CapabilityManifestSchema = object({
  id,
  apiVersion: Type.String({ minLength: 1, maxLength: 32, pattern: "^[0-9]+\\.[0-9]+$" }),
  name: Type.String({ minLength: 1, maxLength: 128 }),
  description: Type.String({ minLength: 1, maxLength: 1024 }),
  kind: Type.Union([Type.Literal("tools"), Type.Literal("workflow")]),
  icon: Type.Optional(Type.Union([Type.Literal("spark"), Type.Literal("grid"), Type.Literal("chat")])),
  configSchema: ExtensionJsonSchemaSchema,
  inputSchema: ExtensionJsonSchemaSchema,
  outputSchema: ExtensionJsonSchemaSchema,
  requiredPermissions: Type.Array(CapabilityPermissionSchema, { maxItems: 8 }),
});

export const CapabilityCatalogEntrySchema = object({
  manifest: CapabilityManifestSchema,
  enabled: Type.Boolean(),
  configured: Type.Boolean(),
  compatible: Type.Boolean(),
  status: Type.Union([
    Type.Literal("enabled"), Type.Literal("disabled"), Type.Literal("needs_configuration"), Type.Literal("incompatible"),
  ]),
  config: boundedJsonObject,
  missingConfiguration: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 32 }),
});
export const CapabilityCatalogSchema = object({
  schemaVersion: Type.Literal(2),
  capabilities: Type.Array(CapabilityCatalogEntrySchema, { maxItems: 128 }),
});

export const UpdateCapabilityStateRequestSchema = object({
  schemaVersion: Type.Literal(2),
  enabled: Type.Optional(Type.Boolean()),
  config: Type.Optional(boundedJsonObject),
});

export const ExtensionResultSchema = object({
  extensionId: id,
  title: Type.String({ minLength: 1, maxLength: 256 }),
  summary: Type.String({ minLength: 1, maxLength: 4096 }),
  output: Type.Any(),
});

export type CapabilityPermission = Static<typeof CapabilityPermissionSchema>;
export type CapabilityManifest = Static<typeof CapabilityManifestSchema>;
export type CapabilityCatalogEntry = Static<typeof CapabilityCatalogEntrySchema>;
export type CapabilityCatalog = Static<typeof CapabilityCatalogSchema>;
export type UpdateCapabilityStateRequest = Static<typeof UpdateCapabilityStateRequestSchema>;
export type ExtensionResult = Static<typeof ExtensionResultSchema>;

export function parseCapabilityManifest(value: unknown): CapabilityManifest {
  if (!Check(CapabilityManifestSchema, value)) throw new Error("Capability manifest validation failed");
  return value as CapabilityManifest;
}

export function parseCapabilityCatalog(value: unknown): CapabilityCatalog {
  if (!Check(CapabilityCatalogSchema, value)) throw new Error("Capability catalog validation failed");
  return value as CapabilityCatalog;
}
