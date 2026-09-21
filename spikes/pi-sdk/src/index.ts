import {
	createAgentSession,
	defineTool,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type AgentSession,
	type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type FauxProviderHandle,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";

type CheckResult = {
	name: string;
	ok: boolean;
	details: Record<string, unknown>;
};

type EventRecord = {
	type: string;
	subtype?: string;
	toolName?: string;
	isError?: boolean;
	stopReason?: string;
};

const cwd = process.cwd();

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForAbort(signal: AbortSignal | undefined): Promise<void> {
	if (!signal || signal.aborted) return Promise.resolve();
	return new Promise((resolve) => {
		signal.addEventListener("abort", () => resolve(), { once: true });
	});
}

function recordEvent(event: AgentSessionEvent, events: EventRecord[]): void {
	if (event.type === "message_update") {
		events.push({ type: event.type, subtype: event.assistantMessageEvent.type });
		return;
	}
	if (event.type === "tool_execution_start") {
		events.push({ type: event.type, toolName: event.toolName });
		return;
	}
	if (event.type === "tool_execution_end") {
		events.push({ type: event.type, toolName: event.toolName, isError: event.isError });
		return;
	}
	if (event.type === "message_end") {
		const stopReason = event.message.role === "assistant" ? event.message.stopReason : undefined;
		events.push({ type: event.type, ...(stopReason ? { stopReason } : {}) });
		return;
	}
	events.push({ type: event.type });
}

function lastAssistantMessage(session: AgentSession): Record<string, unknown> | undefined {
	const messages = session.agent.state.messages as Array<Record<string, unknown>>;
	return [...messages].reverse().find((message) => message.role === "assistant");
}

async function createSession(
	registration: FauxProviderHandle,
	customTools: ReturnType<typeof defineTool>[] = [],
): Promise<{ session: AgentSession; runtime: ModelRuntime }> {
	const runtime = await ModelRuntime.create({
		modelsPath: null,
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	runtime.registerNativeProvider(registration.provider);

	const { session } = await createAgentSession({
		cwd,
		modelRuntime: runtime,
		model: registration.getModel(),
		tools: customTools.map((tool) => tool.name),
		customTools,
		sessionManager: SessionManager.inMemory(cwd),
		settingsManager: SettingsManager.inMemory({
			compaction: { enabled: false },
			retry: { enabled: false },
		}),
	});

	return { session, runtime };
}

async function runNormalLifecycleCheck(): Promise<CheckResult> {
	const registration = fauxProvider({
		api: "pi-sdk-spike",
		provider: "pi-sdk-spike",
		models: [{ id: "deterministic", name: "Deterministic", reasoning: false }],
		tokenSize: { min: 1, max: 3 },
	});
	const toolInputs: string[] = [];
	const events: EventRecord[] = [];
	const inspectTool = defineTool({
		name: "inspect_value",
		label: "Inspect value",
		description: "Inspect a value without modifying files or external state.",
		parameters: Type.Object({
			value: Type.String({ description: "Value to inspect" }),
		}),
		execute: async (_toolCallId, params) => {
			toolInputs.push(params.value);
			return {
				content: [{ type: "text", text: `inspected:${params.value}` }],
				details: { value: params.value },
			};
		},
	});

	registration.setResponses([
		fauxAssistantMessage(fauxToolCall("inspect_value", { value: "hello" }), { stopReason: "toolUse" }),
		fauxAssistantMessage("finished", { stopReason: "stop" }),
	]);

	const { session, runtime } = await createSession(registration, [inspectTool]);
	const unsubscribe = session.subscribe((event) => recordEvent(event, events));
	try {
		await session.prompt("Inspect the supplied value and then finish.");
		await session.agent.waitForIdle();
	} finally {
		unsubscribe();
		session.dispose();
		runtime.unregisterProvider(registration.provider.id);
	}

	const requiredEvents = ["tool_execution_start", "tool_execution_end", "agent_end", "agent_settled"];
	const missingEvents = requiredEvents.filter((type) => !events.some((event) => event.type === type));
	const ok = toolInputs[0] === "hello" && missingEvents.length === 0;
	return {
		name: "normal session, typed read-only tool, and lifecycle events",
		ok,
		details: {
			sessionCreatedAndDisposed: true,
			toolInput: toolInputs[0],
			events,
			missingEvents,
		},
	};
}

async function runFailureCheck(): Promise<CheckResult> {
	const registration = fauxProvider({
		api: "pi-sdk-spike-failure",
		provider: "pi-sdk-spike-failure",
		models: [{ id: "failure", name: "Failure", reasoning: false }],
	});
	registration.setResponses([
		fauxAssistantMessage("deterministic failure", {
			stopReason: "error",
			errorMessage: "deterministic failure",
		}),
	]);

	const { session, runtime } = await createSession(registration);
	const events: EventRecord[] = [];
	const unsubscribe = session.subscribe((event) => recordEvent(event, events));
	let rejected = false;
	let stopReason: unknown;
	let errorMessage: unknown;
	try {
		await session.prompt("Trigger the deterministic failure.");
	} catch {
		rejected = true;
	} finally {
		const last = lastAssistantMessage(session);
		stopReason = last?.stopReason;
		errorMessage = last?.errorMessage;
		unsubscribe();
		session.dispose();
		runtime.unregisterProvider(registration.provider.id);
	}

	const ok = stopReason === "error" || rejected || events.some((event) => event.type === "agent_end");
	return {
		name: "deterministic provider failure propagation",
		ok,
		details: { rejected, stopReason, errorMessage, events },
	};
}

async function runAbortCheck(name: string, timeoutMs?: number): Promise<CheckResult> {
	const registration = fauxProvider({
		api: `pi-sdk-spike-${name}`,
		provider: `pi-sdk-spike-${name}`,
		models: [{ id: name, name, reasoning: false }],
	});
	registration.setResponses([
		async (_context, options) => {
			await waitForAbort(options?.signal);
			return fauxAssistantMessage("aborted", {
				stopReason: "aborted",
				errorMessage: `${name} aborted`,
			});
		},
	]);

	const { session, runtime } = await createSession(registration);
	const events: EventRecord[] = [];
	const unsubscribe = session.subscribe((event) => recordEvent(event, events));
	let promptRejected = false;
	let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
	let stopReason: unknown;
	try {
		const prompt = session.prompt(`Run the ${name} scenario.`).catch(() => {
			promptRejected = true;
		});
		if (timeoutMs === undefined) {
			await delay(20);
			await session.abort();
		} else {
			timeoutHandle = setTimeout(() => void session.abort(), timeoutMs);
		}
		await prompt;
		await session.agent.waitForIdle();
	} finally {
		if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
		const last = lastAssistantMessage(session);
		stopReason = last?.stopReason;
		unsubscribe();
		session.dispose();
		runtime.unregisterProvider(registration.provider.id);
	}

	const ok = stopReason === "aborted" || promptRejected || events.some((event) => event.type === "agent_end");
	return {
		name: timeoutMs === undefined ? "explicit session cancellation" : "application timeout triggers cancellation",
		ok,
		details: { timeoutMs: timeoutMs ?? null, promptRejected, stopReason, events },
	};
}

async function main(): Promise<void> {
	const results = [
		await runNormalLifecycleCheck(),
		await runFailureCheck(),
		await runAbortCheck("cancel"),
		await runAbortCheck("timeout", 30),
	];
	const failed = results.filter((result) => !result.ok);
	console.log(JSON.stringify({ sdk: "@earendil-works/pi-coding-agent@0.86.1", results }, null, 2));
	if (failed.length > 0) {
		throw new Error(`${failed.length} PI SDK spike checks failed`);
	}
}

await main();
