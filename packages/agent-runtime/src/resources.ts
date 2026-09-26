import { createExtensionRuntime, type ResourceLoader } from "@earendil-works/pi-coding-agent";

// 只接受应用自有文本；目标仓库和用户 HOME 中的资源都不能自动变成 Agent 指令。
export function resources(systemPrompt: string): ResourceLoader {
  // SDK 需要完整 ResourceLoader 形状，因此显式返回空集合，不让默认行为触发本机资源发现。
  const extensions = { extensions: [], errors: [], runtime: createExtensionRuntime() };
  return {
    getExtensions: () => extensions,
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => { throw new Error("Resource discovery is disabled"); },
    reload: async () => {},
  };
}
