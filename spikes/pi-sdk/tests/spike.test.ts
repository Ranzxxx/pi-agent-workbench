import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DefaultResourceLoader, ModelRuntime, type CreateModelRuntimeOptions } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { assertCancelled, assertFailure, assertNormal, assertToolCancelled } from "../src/assertions.js";
import { failureCheck, normalCheck, runChecks } from "../src/checks.js";
import { withDeadline } from "../src/harness.js";

test("all SDK lifecycle scenarios", { timeout: 15000 }, async () => {
	assert.equal((await runChecks()).length, 7);
});

test("normal completion, unrelated errors, and missing abort signals fail negative assertions", async () => {
	const normal = await normalCheck();
	assert.throws(() => assertFailure(normal));
	assert.throws(() => assertCancelled(normal, true, 1));
	const failure = await failureCheck();
	assert.throws(() => assertCancelled(failure, true, 1));
	assert.throws(() => assertToolCancelled(failure, true, 1));
	assert.throws(() => assertFailure({ ...failure, finalMessage: { ...failure.finalMessage!, errorMessage: "unrelated" } }));
	const aborted = {
		...failure, finalMessage: { ...failure.finalMessage!, stopReason: "aborted" as const },
		events: failure.events.map((event) => event.stopReason === "error" ? { ...event, stopReason: "aborted" } : event),
	};
	assert.throws(() => assertCancelled(aborted, false, 1));
	assert.throws(() => assertCancelled(aborted, true, 1001));
});

test("corrupted tool results, final text, and lifecycle order fail assertions", async () => {
	const normal = await normalCheck();
	assert.throws(() => assertNormal({ ...normal, events: normal.events.map((event) => event.type === "tool_execution_end" ? { ...event, result: {} } : event) }));
	assert.throws(() => assertNormal({ ...normal, finalMessage: { ...normal.finalMessage!, content: [] } }));
	assert.throws(() => assertNormal({ ...normal, events: [...normal.events].reverse() }));
	assert.throws(() => assertNormal({ ...normal, events: normal.events.filter((event) => event.type !== "agent_settled") }));
	assert.throws(() => assertNormal({ ...normal, events: [...normal.events, { type: "agent_end" }] }));
});

test("filesystem auth, extensions, and context cannot enter the isolated session", async (t) => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-spike-isolation-"));
	const marker = join(cwd, "extension-ran");
	const sentinel = "UNTRUSTED_SPIKE_SENTINEL";
	const createRuntime = ModelRuntime.create;
	t.mock.method(ModelRuntime, "create", async (options: CreateModelRuntimeOptions = {}) => {
		assert.ok(options.credentials instanceof InMemoryCredentialStore, "File-backed default credentials are forbidden");
		assert.equal(options.modelsPath, null);
		assert.equal(options.allowModelNetwork, false);
		return createRuntime.call(ModelRuntime, options);
	});
	t.mock.method(DefaultResourceLoader.prototype, "reload", () => { throw new Error("Default resource discovery must not run"); });
	try {
		await mkdir(join(cwd, ".pi", "extensions"), { recursive: true });
		await writeFile(join(cwd, "auth.json"), "invalid auth file must not be read");
		await writeFile(join(cwd, "AGENTS.md"), sentinel);
		await writeFile(join(cwd, ".pi", "SYSTEM.md"), sentinel);
		await writeFile(join(cwd, ".pi", "extensions", "sentinel.ts"), "import {writeFileSync} from 'node:fs'; writeFileSync(" + JSON.stringify(marker) + ", 'loaded'); export default function() { throw new Error('Untrusted extension loaded'); }");
		await normalCheck(cwd, sentinel);
		await assert.rejects(access(marker), { code: "ENOENT" });
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("stalled operations and unexpected rejections fail explicitly", async () => {
	await assert.rejects(withDeadline(new Promise(() => {}), "stalled", 10), /stalled exceeded/);
	await assert.rejects(withDeadline(Promise.reject(new Error("unexpected")), "rejection"), /unexpected/);
});
