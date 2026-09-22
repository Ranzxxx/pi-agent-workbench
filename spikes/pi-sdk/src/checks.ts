import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { assertCancelled, assertEnded, assertFailure, assertNormal, assertToolCancelled } from "./assertions.js";
import { createHarness, deferred, waitForAbort, withDeadline } from "./harness.js";

function provider(name: string) {
	return fauxProvider({
		api: "spike-" + name, provider: "spike-" + name,
		models: [{ id: name, name, reasoning: false }], tokenSize: { min: 2, max: 2 },
	});
}

export async function normalCheck(cwd?: string, forbiddenContext?: string) {
	const faux = provider("normal");
	const inputs: string[] = [];
	const tool = defineTool({
		name: "inspect_value", label: "Inspect value", description: "Read a value without side effects.",
		parameters: Type.Object({ value: Type.String() }),
		execute: async (_id, params) => {
			inputs.push(params.value);
			return { content: [{ type: "text", text: "inspected:" + params.value }], details: { value: params.value } };
		},
	});
	faux.setResponses([
		(context) => {
			if (forbiddenContext) assert.equal(JSON.stringify(context).includes(forbiddenContext), false);
			return fauxAssistantMessage(fauxToolCall("inspect_value", { value: "hello" }, { id: "inspect-1" }), { stopReason: "toolUse" });
		},
		fauxAssistantMessage("finished"),
	]);
	const harness = await createHarness(faux, [tool], cwd);
	try {
		await withDeadline(harness.session.prompt("Inspect hello."), "normal scenario");
		await withDeadline(harness.session.waitForIdle(), "normal idle");
		const result = harness.observe();
		assert.deepEqual(inputs, ["hello"]);
		assertNormal(result);
		return result;
	} finally {
		await harness.dispose();
	}
}

export async function failureCheck() {
	const faux = provider("failure");
	faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "deterministic failure" })]);
	const harness = await createHarness(faux);
	try {
		await withDeadline(harness.session.prompt("Fail."), "failure scenario");
		await withDeadline(harness.session.waitForIdle(), "failure idle");
		const result = harness.observe();
		assertFailure(result);
		return result;
	} finally {
		await harness.dispose();
	}
}

export async function toolErrorCheck(invalidInput: boolean) {
	const faux = provider(invalidInput ? "invalid-input" : "tool-error");
	let executions = 0;
	const tool = defineTool({
		name: "inspect_value", label: "Inspect value", description: "Validate input and expose a controlled error.",
		parameters: Type.Object({ value: Type.String() }),
		execute: async () => { executions++; throw new Error("deterministic tool failure"); },
	});
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("inspect_value", invalidInput ? {} : { value: "hello" }), { stopReason: "toolUse" }),
		fauxAssistantMessage("tool failure acknowledged"),
	]);
	const harness = await createHarness(faux, [tool]);
	try {
		await withDeadline(harness.session.prompt("Inspect."), "tool error scenario");
		await withDeadline(harness.session.waitForIdle(), "tool error idle");
		const result = harness.observe();
		assertEnded(result, "stop");
		assert.equal(executions, invalidInput ? 0 : 1);
		const ends = result.events.filter((event) => event.type === "tool_execution_end");
		assert.equal(ends.length, 1);
		assert.equal(ends[0]?.isError, true);
		assert.match(JSON.stringify(ends[0]?.result), invalidInput ? /value|validat/i : /deterministic tool failure/);
		return result;
	} finally {
		await harness.dispose();
	}
}

export async function cancelCheck(mode: "cancel" | "timeout" | "tool") {
	const faux = provider(mode);
	const started = deferred();
	let signalObserved = false;
	async function operation(signal: AbortSignal | undefined) {
		started.resolve();
		await waitForAbort(signal);
		signalObserved = signal?.aborted === true;
	}
	const tool = defineTool({
		name: "wait_read", label: "Wait read", description: "Wait for cancellation without side effects.",
		parameters: Type.Object({}),
		execute: async (_id, _params, signal) => {
			await operation(signal);
			throw new Error("Read cancelled");
		},
	});
	faux.setResponses(mode === "tool" ? [
		fauxAssistantMessage(fauxToolCall("wait_read", {}), { stopReason: "toolUse" }),
	] : [async (_context, options) => {
		await operation(options?.signal);
		return fauxAssistantMessage("", { stopReason: "aborted", errorMessage: "Request was aborted" });
	}]);
	const harness = await createHarness(faux, mode === "tool" ? [tool] : []);
	try {
		const prompt = harness.session.prompt("Run " + mode + ".");
		void prompt.catch(() => {}); // The original promise is awaited below; unexpected errors still fail.
		await withDeadline(Promise.race([started.promise, prompt.then(() => { throw new Error("Operation never started"); })]), "operation start");
		if (mode === "timeout") await delay(30);
		const cancellationStarted = performance.now();
		await withDeadline(Promise.all([harness.session.abort(), prompt]), "cancellation", 1000);
		await withDeadline(harness.session.waitForIdle(), "cancel idle");
		const result = harness.observe();
		const elapsedMs = performance.now() - cancellationStarted;
		if (mode === "tool") {
			assertToolCancelled(result, signalObserved, elapsedMs);
		} else {
			assertCancelled(result, signalObserved, elapsedMs);
		}
		return { ...result, signalObserved, elapsedMs };
	} finally {
		await harness.dispose();
	}
}

export async function runChecks() {
	const scenarios = [
		["normal", normalCheck], ["provider_failure", failureCheck],
		["invalid_tool_input", () => toolErrorCheck(true)], ["tool_failure", () => toolErrorCheck(false)],
		["cancel", () => cancelCheck("cancel")], ["timeout", () => cancelCheck("timeout")],
		["tool_cancel", () => cancelCheck("tool")],
	] as const;
	const results = [];
	for (const [name, check] of scenarios) {
		const observation = await withDeadline(check(), name, 5000);
		results.push({ name, ok: true, details: observation });
	}
	return results;
}
