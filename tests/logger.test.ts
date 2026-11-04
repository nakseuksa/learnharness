import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import { createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { isLogEnabled, lhLog, traceObject } from "../src/core/logger.ts";
import { newHandoffMessage, newUserMessage, newUserSteer, toLlmMessages } from "../src/core/native-messages.ts";
import { serverExecute } from "../src/agent/tool-execute.ts";
import { runPiTurn, type TurnWireEvent } from "../src/server/pi/ui-stream.ts";

function configureLogging(t: TestContext, selection: string) {
	const previous = process.env.LH_LOG;
	process.env.LH_LOG = selection;
	t.after(() => {
		if (previous === undefined) delete process.env.LH_LOG;
		else process.env.LH_LOG = previous;
	});
	return t.mock.method(console, "info", () => {});
}

test("logging defaults and scope selection keep streaming opt-in", (t) => {
	const previous = process.env;
	process.env = { ...previous };
	t.after(() => { process.env = previous; });
	configureLogging(t, "");
	for (const mode of ["test", "production", "development"] as const) {
		process.env = { ...process.env, NODE_ENV: mode };
		assert.equal(isLogEnabled("AGENT"), mode === "development");
		assert.equal(isLogEnabled("STREAM"), false);
	}
	for (const [selection, agent, stream] of [
		["0", false, false], ["false", false, false], ["1", true, false],
		["agent", true, false], ["stream", false, true], ["*,stream", true, true],
	] as const) {
		process.env.LH_LOG = selection;
		assert.equal(isLogEnabled("AGENT"), agent, selection);
		assert.equal(isLogEnabled("STREAM"), stream, selection);
	}
});

test("disabled logging never formats details or writes to the console", (t) => {
	const output = configureLogging(t, "0");
	lhLog("TOOL", "ignored", { get value() { throw new Error("Must not inspect details"); } });
	assert.equal(output.mock.callCount(), 0);
});

test("formatting and console failures cannot escape the logger", (t) => {
	const output = configureLogging(t, "1");
	assert.doesNotThrow(() => lhLog("TOOL", "format", {
		get value() { throw new Error("Synthetic formatter failure"); },
	}));
	output.mock.mockImplementation(() => { throw new Error("Synthetic console failure"); });
	assert.doesNotThrow(() => lhLog("TOOL", "output", { count: 1 }));
});

test("store tracing preserves results and original failures when logging fails", async (t) => {
	const output = configureLogging(t, "STORE");
	output.mock.mockImplementation(() => { throw new Error("Synthetic console failure"); });
	const originalError = new Error("Original store failure");
	const store = traceObject("STORE", "fixture", {
		count: 0,
		increment() { return ++this.count; },
		async read() { return this.count; },
		fail() { throw originalError; },
		async reject() { throw originalError; },
	});
	assert.equal(store.increment, store.increment);
	assert.equal(store.increment(), 1);
	assert.equal(await store.read(), 1);
	assert.throws(() => store.fail(), (error) => error === originalError);
	await assert.rejects(store.reject(), (error) => error === originalError);
});

test("tool logs never serialize or expose raw input", async (t) => {
	const output = configureLogging(t, "TOOL");
	let serializations = 0;
	const input = {
		url: "https://example.invalid/?token=private-token",
		message: "PRIVATE_LEARNER_CONTENT",
		toJSON() { serializations++; return { url: this.url, message: this.message }; },
	};
	let received: unknown;
	const schema = Type.Object({ url: Type.String(), message: Type.String() });
	const execute = serverExecute("fixture", schema, (value) => {
		received = value;
		return "ok";
	});
	assert.deepEqual((await execute("call_fixture", input)).content, [{ type: "text", text: "ok" }]);
	assert.equal(received, input);
	const originalError = new Error(`Request failed for ${input.url}`);
	const fail = serverExecute("fixture", schema, () => { throw originalError; });
	await assert.rejects(fail("call_failure", input), (error) => error === originalError);
	assert.equal(serializations, 0);
	const logs = output.mock.calls.map((call) => call.arguments.join(" ")).join("\n");
	assert.match(logs, /fixture/);
	assert.match(logs, /call_fixture/);
	assert.match(logs, /ms=/);
	assert.doesNotMatch(logs, /private-token|PRIVATE_LEARNER_CONTENT|example\.invalid/);
});

for (const [selection, brokenConsole] of [["0", false], ["AGENT", false], ["STREAM", false], ["AGENT", true]] as const) {
	test(`string steers and markers settle cleanly with LH_LOG=${selection}, brokenConsole=${brokenConsole}`, async (t) => {
		const output = configureLogging(t, selection);
		if (brokenConsole) output.mock.mockImplementation(() => { throw new Error("Synthetic console failure"); });
		const faux = createFauxCore({});
		let modelCalls = 0;
		let context = "";
		faux.setResponses([(request) => {
			modelCalls++;
			context = JSON.stringify(request.messages);
			return fauxAssistantMessage("Synthetic reply.");
		}]);
		const agent = new Agent({
			initialState: { model: faux.getModel(), messages: [newUserMessage("Initial input")] },
			streamFn: faux.streamSimple,
			convertToLlm: toLlmMessages,
			steeringMode: "all",
		});
		const marker = newHandoffMessage("logger_fixture");
		const steers = [newUserSteer("Synthetic learner steer", "steer_logger"), marker];
		for (const steer of steers) agent.steer(steer);
		let saves = 0;
		let settledMessages: AgentMessage[] = [];
		const handle = runPiTurn({
			agent,
			onFinish(messages) { saves++; settledMessages = messages; },
		});
		const wire = await new Response(handle.subscribe()).text();
		await agent.waitForIdle();
		const events = wire.split("\n\n")
			.filter((frame) => frame.startsWith("data: {"))
			.map((frame) => JSON.parse(frame.slice(6)) as TurnWireEvent);
		assert.equal(modelCalls, 1);
		assert.equal(saves, 1);
		assert.match(context, /Synthetic learner steer/);
		assert.ok(context.includes(marker.content));
		for (const steer of steers) {
			assert.ok(settledMessages.includes(steer), "the original steer survives settlement");
			assert.ok(events.some((event) => event.type === "message_end" && "id" in event.message && event.message.id === steer.id));
		}
		assert.equal(events.some((event) => event.type === "error"), false);
		assert.equal(agent.state.errorMessage, undefined);
		assert.ok(wire.endsWith("data: [DONE]\n\n"));
	});
}
