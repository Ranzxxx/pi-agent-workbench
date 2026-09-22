import assert from "node:assert/strict";
import {
	createAgentSession, createExtensionRuntime, ModelRuntime,
	SessionManager, SettingsManager,
	type AgentSessionEvent, type ResourceLoader, type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, type AssistantMessage, type FauxProviderHandle } from "@earendil-works/pi-ai";

export type EventRecord = {
	type: string;
	subtype?: string;
	delta?: string;
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
	result?: unknown;
	stopReason?: string;
};
export type Observation = {
	events: EventRecord[];
	finalMessage?: AssistantMessage;
	activeTools: string[];
	pendingResponses: number;
};

// No filesystem discovery: extensions, skills, context files and prompts stay empty.
function createResources(): ResourceLoader {
	const extensions = { extensions: [], errors: [], runtime: createExtensionRuntime() };
	return {
		getExtensions: () => extensions,
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => "Run only the scripted PI SDK lifecycle checks with explicitly allowed tools.",
		getSystemPromptSource: () => undefined,
		getAppendSystemPrompt: () => [],
		getAppendSystemPromptSources: () => [],
		extendResources: () => { throw new Error("Resource extension is disabled in the offline spike"); },
		reload: async () => {},
	};
}

function record(event: AgentSessionEvent): EventRecord {
	if (event.type === "message_update") {
		const update = event.assistantMessageEvent;
		return {
			type: event.type, subtype: update.type,
			...(update.type === "text_delta" ? { delta: update.delta } : {}),
		};
	}
	if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
		return {
			type: event.type, toolCallId: event.toolCallId, toolName: event.toolName,
			...(event.type === "tool_execution_end" ? { isError: event.isError, result: event.result } : {}),
		};
	}
	if (event.type === "message_end" && event.message.role === "assistant") {
		return { type: event.type, stopReason: event.message.stopReason };
	}
	return { type: event.type };
}

export function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}

export function waitForAbort(signal: AbortSignal | undefined): Promise<void> {
	assert.ok(signal, "An AbortSignal must reach the provider/tool");
	if (signal.aborted) return Promise.resolve();
	return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}

export async function withDeadline<T>(work: Promise<T>, label: string, ms = 3000): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			work,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(label + " exceeded " + ms + " ms")), ms);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

export async function createHarness(
	faux: FauxProviderHandle,
	customTools: ToolDefinition[] = [],
	cwd = process.cwd(),
) {
	const runtime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null, allowModelNetwork: false, refreshOnCreate: false,
	});
	runtime.registerNativeProvider(faux.provider);
	try {
		const { session } = await createAgentSession({
			cwd, agentDir: cwd, modelRuntime: runtime, model: faux.getModel(),
			resourceLoader: createResources(),
			tools: customTools.map((tool) => tool.name), customTools,
			sessionManager: SessionManager.inMemory(cwd),
			settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
		});
		const events: EventRecord[] = [];
		const unsubscribe = session.subscribe((event) => events.push(record(event)));
		return {
			session,
			observe: (): Observation => ({
				events: [...events], activeTools: session.getActiveToolNames(),
				pendingResponses: faux.getPendingResponseCount(),
				finalMessage: session.messages.filter((message): message is AssistantMessage => message.role === "assistant").at(-1),
			}),
			async dispose() {
				try {
					await withDeadline(session.abort(), "session cleanup", 1000);
				} finally {
					unsubscribe();
					session.dispose();
					runtime.unregisterProvider(faux.provider.id);
				}
			},
		};
	} catch (error) {
		runtime.unregisterProvider(faux.provider.id);
		throw error;
	}
}
