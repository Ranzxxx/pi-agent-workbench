import assert from "node:assert/strict";
import type { Observation } from "./harness.js";

export function assertEnded(observation: Observation, reason: "stop" | "error" | "aborted"): void {
	assert.equal(observation.finalMessage?.stopReason, reason, "Unexpected assistant stopReason: " + (observation.finalMessage?.errorMessage ?? "no error message"));
	const { events } = observation;
	for (const type of ["agent_start", "agent_end", "agent_settled"]) {
		assert.equal(events.filter((event) => event.type === type).length, 1, "Expected exactly one " + type);
	}
	const end = events.findIndex((event) => event.type === "agent_end");
	const settled = events.findIndex((event) => event.type === "agent_settled");
	const message = events.findLastIndex((event) => event.type === "message_end" && event.stopReason === reason);
	assert.ok(message > events.findIndex((event) => event.type === "agent_start"));
	assert.ok(message < end && end < settled, "Final message must precede agent_end and agent_settled");
	assert.equal(observation.pendingResponses, 0, "Scripted model responses were not consumed");
}

export function assertFailure(observation: Observation): void {
	assertEnded(observation, "error");
	assert.equal(observation.finalMessage?.errorMessage, "deterministic failure");
}

export function assertCancelled(observation: Observation, signalObserved: boolean, elapsedMs: number): void {
	assertEnded(observation, "aborted");
	assert.equal(signalObserved, true, "Cancellation never reached the active operation");
	assert.ok(elapsedMs < 1000, "Cancellation exceeded 1000 ms: " + elapsedMs);
}

export function assertToolCancelled(observation: Observation, signalObserved: boolean, elapsedMs: number): void {
	// In 0.86.1 the post-tool request can fail in ModelRuntime before reaching faux.
	// Characterize that exact abort error; never accept an arbitrary provider failure.
	assertEnded(observation, "error");
	assert.equal(observation.finalMessage?.errorMessage, "This operation was aborted");
	assert.equal(signalObserved, true, "Cancellation never reached the running tool");
	assert.ok(elapsedMs < 1000);
	const starts = observation.events.filter((event) => event.type === "tool_execution_start");
	const ends = observation.events.filter((event) => event.type === "tool_execution_end");
	assert.equal(starts.length, 1);
	assert.equal(ends.length, 1);
	assert.equal(starts[0]?.toolName, "wait_read");
	assert.equal(starts[0]?.toolCallId, ends[0]?.toolCallId);
	assert.ok(observation.events.indexOf(starts[0]!) < observation.events.indexOf(ends[0]!));
	assert.equal(ends[0]?.isError, true);
	assert.match(JSON.stringify(ends[0]?.result), /Read cancelled/);
	assert.equal(observation.events.some((event) => event.subtype === "text_delta"), false);
}

export function assertNormal(observation: Observation): void {
	assertEnded(observation, "stop");
	assert.deepEqual(observation.activeTools, ["inspect_value"]);
	assert.deepEqual(observation.finalMessage?.content, [{ type: "text", text: "finished" }]);
	const { events } = observation;
	const starts = events.filter((event) => event.type === "tool_execution_start");
	const ends = events.filter((event) => event.type === "tool_execution_end");
	assert.equal(starts.length, 1);
	assert.equal(ends.length, 1);
	assert.equal(starts[0]?.toolName, "inspect_value");
	assert.equal(starts[0]?.toolCallId, "inspect-1");
	assert.equal(ends[0]?.toolCallId, starts[0]?.toolCallId);
	assert.equal(ends[0]?.isError, false);
	assert.deepEqual(ends[0]?.result, {
		content: [{ type: "text", text: "inspected:hello" }], details: { value: "hello" },
	});
	const callEnd = events.findIndex((event) => event.subtype === "toolcall_end");
	assert.ok(callEnd >= 0 && callEnd < events.indexOf(starts[0]!));
	assert.ok(events.indexOf(starts[0]!) < events.indexOf(ends[0]!));
	assert.ok(events.indexOf(ends[0]!) < events.findIndex((event) => event.subtype === "text_delta"));
	assert.equal(events.filter((event) => event.subtype === "text_delta").map((event) => event.delta).join(""), "finished");
}
