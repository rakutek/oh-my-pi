import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Agent, AgentEvent } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EditTool, getEditStore } from "@oh-my-pi/pi-coding-agent/edit";
import { StreamingEditGuard } from "@oh-my-pi/pi-coding-agent/session/stream-guards";
import { formatHashlineHeader } from "@oh-my-pi/pi-tui/tools/hashline-format";
import type { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

function createGuard(
	streamingAbort: boolean,
	cwd = process.cwd(),
	settings = Settings.isolated({ "edit.streamingAbort": streamingAbort }),
): { guard: StreamingEditGuard; aborts: { count: number; reason?: unknown } } {
	const aborts: { count: number; reason?: unknown } = { count: 0 };
	const guard = new StreamingEditGuard({
		agent: {
			abort(reason?: unknown) {
				aborts.count++;
				aborts.reason = reason;
			},
		} as Agent,
		settings,
		sessionManager: { getCwd: () => cwd } as SessionManager,
		model: () => undefined,
		isDisposed: () => false,
		promptGeneration: () => 0,
		emitNotice() {},
		schedulePostPromptTask() {},
		discardAssistantTurn() {},
	});
	return { guard, aborts };
}

function previewEvent(
	streaming: boolean,
	files: Array<{ path: string; error?: string }>,
	toolName = "edit",
): AgentEvent {
	return {
		type: "tool_stream_update",
		toolCallId: "call-edit-1",
		toolName,
		update: { generation: 1, streaming, files },
	};
}

describe("streamed edit revisions", () => {
	test("executes revised arguments instead of the cached streamed edit", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "stream-revision-"));
		try {
			const filePath = path.join(cwd, "sample.jl");
			const initial = "value = original\n";
			await Bun.write(filePath, initial);
			const settings = Settings.isolated({ "edit.mode": "hashline" });
			const toolSession = {
				cwd,
				hasUI: false,
				getSessionFile: () => null,
				getSessionSpawns: () => "*",
				enableLsp: false,
				settings,
				getArtifactsDir: () => null,
				getSessionId: () => null,
				getPlanModeState: () => undefined,
			} as unknown as ToolSession;
			const tool = new EditTool(toolSession, "hashline");
			const tag = getEditStore(toolSession).recordSnapshot(filePath, initial);
			const header = formatHashlineHeader("sample.jl", tag);
			const original = {
				title: "Keep the original branch",
				input: `*** Reason: Preserve compact branching\n${header}\nPUT 1-1:\n+value = condition ? left : right`,
			};
			const revised = {
				title: "Use explicit branching",
				input: `*** Reason: Make branches easier to read\n${header}\nPUT 1-1:\n+value = if condition\n+    left\n+else\n+    right\n+end`,
			};
			const stream = tool.openArgStream({
				toolCallId: "revised-edit",
				toolName: "edit",
				emit() {},
			});
			const encoded = JSON.stringify(original);
			for (let offset = 0; offset < encoded.length; offset += 7) stream.push(encoded.slice(offset, offset + 7));
			stream.end(original);

			const result = await tool.execute("revised-edit", revised);

			expect(result.isError).not.toBe(true);
			expect(await Bun.file(filePath).text()).toBe("value = if condition\n    left\nelse\n    right\nend\n");
		} finally {
			await removeWithRetries(cwd);
		}
	});
});

describe("streamed edit reasons", () => {
	for (const mode of ["hashline", "apply_patch"] as const) {
		test(`${mode} previews and applies a reason-prefixed edit across every character boundary`, async () => {
			const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "stream-reason-"));
			try {
				const filePath = path.join(cwd, "sample.txt");
				const initial = "before\n";
				await Bun.write(filePath, initial);
				const toolSession = {
					cwd,
					hasUI: false,
					getSessionFile: () => null,
					getSessionSpawns: () => "*",
					enableLsp: false,
					settings: Settings.isolated({ "edit.mode": mode }),
					getArtifactsDir: () => null,
					getSessionId: () => null,
					getPlanModeState: () => undefined,
				} as unknown as ToolSession;
				const tool = new EditTool(toolSession, mode);
				const tag = getEditStore(toolSession).recordSnapshot(filePath, initial);
				const patch =
					mode === "hashline"
						? `*** Begin Patch\n${formatHashlineHeader("sample.txt", tag)}\nPUT 1.=1:\n+after\n*** End Patch\n`
						: "*** Begin Patch\n*** Update File: sample.txt\n@@\n-before\n+after\n*** End Patch\n";
				const reason = "*** Reason: 誤った値を修正する\n";
				const args = { title: "値の整合性を保つ", input: reason + patch };
				const finalPreview = Promise.withResolvers<{ diff?: string; error?: string } | undefined>();
				const stream = tool.openArgStream({
					toolCallId: "reason-edit",
					toolName: "edit",
					customWireName: mode === "hashline" ? "edit" : undefined,
					emit: update => {
						if (update && typeof update === "object" && "streaming" in update && update.streaming === false) {
							const files = "files" in update && Array.isArray(update.files) ? update.files : [];
							finalPreview.resolve(files[0] as { diff?: string; error?: string } | undefined);
						}
					},
				});
				const encoded =
					mode === "hashline"
						? args.input
						: JSON.stringify(args).replace("*** Reason:", "\\u002a** Reason:").replace("\\n", "\\u000a");
				for (const char of encoded) stream.push(char);
				stream.end(args);
				const preview = await finalPreview.promise;
				expect(preview?.error).toBeUndefined();
				expect(preview?.diff).toContain("+1|after");
				expect(tool.matcherPaths(args)).toEqual(["sample.txt"]);
				expect(tool.formatApprovalDetails(args)).toEqual(["File: sample.txt"]);
				const result = await tool.execute("reason-edit", args);
				expect(result.isError).not.toBe(true);
				expect(await Bun.file(filePath).text()).toBe("after\n");
			} finally {
				await removeWithRetries(cwd);
			}
		});
	}

	test("a reason-only call has no targets, while a completed sloppy edit keeps reason-like file content", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "reason-only-"));
		try {
			const filePath = path.join(cwd, "sample.txt");
			await Bun.write(filePath, "before\n");
			const toolSession = {
				cwd,
				hasUI: false,
				getSessionFile: () => null,
				getSessionSpawns: () => "*",
				getArtifactsDir: () => null,
				getSessionId: () => null,
				enableLsp: false,
				settings: Settings.isolated({ "edit.mode": "sloppy" }),
				getPlanModeState: () => undefined,
			} as unknown as ToolSession;
			const tool = new EditTool(toolSession, "sloppy");
			const args = { input: "*** Reason: *** Edit File: sample.txt" };
			expect(tool.matcherPaths(args)).toBeUndefined();
			const result = await tool.execute("reason-only", args);
			expect(result.isError).toBe(true);
			expect(await Bun.file(filePath).text()).toBe("before\n");
			const completed = await tool.execute("complete-reason", {
				input: "*** Reason: Preserve a literal marker\n*** Edit File: sample.txt\n*** Find\nbefore\n*** Replace\n*** Reason: literal file content\n",
			});
			expect(completed.isError).not.toBe(true);
			expect(await Bun.file(filePath).text()).toBe("*** Reason: literal file content\n");
		} finally {
			await removeWithRetries(cwd);
		}
	});
});

describe("streaming edit abort", () => {
	test("aborts from a final preview emitted by EditTool.openArgStream", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "stream-preview-"));
		try {
			await Bun.write(path.join(cwd, "sample.txt"), "alpha\n");
			const settings = Settings.isolated({ "edit.mode": "patch", "edit.streamingAbort": true });
			const { guard, aborts } = createGuard(true, cwd, settings);
			const toolSession = {
				cwd,
				hasUI: false,
				getSessionFile: () => null,
				getSessionSpawns: () => "*",
				enableLsp: false,
				settings,
				getArtifactsDir: () => null,
				getSessionId: () => null,
				getPlanModeState: () => undefined,
			} as unknown as ToolSession;
			const tool = new EditTool(toolSession, "patch");
			const args = { path: "sample.txt", edits: [{ diff: "@@\n-missing\n+replacement\n" }] };
			const finalPreview = Promise.withResolvers<void>();
			const stream = tool.openArgStream({
				toolCallId: "native-stream",
				toolName: "edit",
				emit: update => {
					guard.maybeAbort({
						type: "tool_stream_update",
						toolCallId: "native-stream",
						toolName: "edit",
						update,
					});
					if (update && typeof update === "object" && "streaming" in update && update.streaming === false) {
						finalPreview.resolve();
					}
				},
			});
			const encoded = JSON.stringify(args);
			for (let offset = 0; offset < encoded.length; offset += 7) stream.push(encoded.slice(offset, offset + 7));
			stream.end(args);
			await finalPreview.promise;

			expect(aborts.count).toBe(1);
			expect(guard.abortTriggered).toBe(true);
			stream.cancel();
		} finally {
			await removeWithRetries(cwd);
		}
	});

	test("aborts on an error from the native final preview", () => {
		const { guard, aborts } = createGuard(true);
		guard.maybeAbort(
			previewEvent(false, [
				{ path: "src/ok.ts" },
				{ path: "src/broken.ts", error: "Failed to find expected lines in src/broken.ts" },
			]),
		);
		expect(aborts.count).toBe(1);
		expect(guard.abortTriggered).toBe(true);
	});

	test("does not abort on a native no-op identical replacement preview", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "stream-preview-noop-"));
		try {
			await Bun.write(path.join(cwd, "sample.txt"), "alpha\n");
			const settings = Settings.isolated({ "edit.mode": "replace", "edit.streamingAbort": true });
			const { guard, aborts } = createGuard(true, cwd, settings);
			const toolSession = {
				cwd,
				hasUI: false,
				getSessionFile: () => null,
				getSessionSpawns: () => "*",
				enableLsp: false,
				settings,
				getArtifactsDir: () => null,
				getSessionId: () => null,
				getPlanModeState: () => undefined,
			} as unknown as ToolSession;
			const tool = new EditTool(toolSession, "replace");
			const args = { path: "sample.txt", old_string: "alpha\n", new_string: "alpha\n" };
			const finalPreview = Promise.withResolvers<string | undefined>();
			const stream = tool.openArgStream({
				toolCallId: "native-noop-stream",
				toolName: "edit",
				emit: update => {
					guard.maybeAbort({
						type: "tool_stream_update",
						toolCallId: "native-noop-stream",
						toolName: "edit",
						update,
					});
					if (update && typeof update === "object" && "streaming" in update && update.streaming === false) {
						const files = "files" in update && Array.isArray(update.files) ? update.files : [];
						const first = files[0] as { error?: unknown } | undefined;
						finalPreview.resolve(typeof first?.error === "string" ? first.error : undefined);
					}
				},
			});
			const encoded = JSON.stringify(args);
			for (let offset = 0; offset < encoded.length; offset += 7) stream.push(encoded.slice(offset, offset + 7));
			stream.end(args);
			const previewError = await finalPreview.promise;
			// Proves the test traversed the native no-op path (not a hand-built string).
			expect(previewError).toContain("No changes would be made");
			expect(aborts.count).toBe(0);
			expect(guard.abortTriggered).toBe(false);
			stream.cancel();
		} finally {
			await removeWithRetries(cwd);
		}
	});

	test("carries tool-scoped diagnostic through abort reason on patch preview failure", () => {
		const { guard, aborts } = createGuard(true);
		guard.maybeAbort(previewEvent(false, [{ path: "src/broken.ts", error: "Line 99 does not exist" }]));
		expect(aborts.count).toBe(1);
		expect(guard.abortTriggered).toBe(true);
		expect(aborts.reason).toBeDefined();
		const reason = aborts.reason as { toolCallMessages?: Record<string, string> };
		expect(reason.toolCallMessages?.["call-edit-1"]).toContain("Line 99 does not exist");
	});

	test("does not abort for transient streaming errors", () => {
		const { guard, aborts } = createGuard(true);
		guard.maybeAbort(previewEvent(true, [{ path: "src/broken.ts", error: "partial input" }]));
		expect(aborts.count).toBe(0);
		expect(guard.abortTriggered).toBe(false);
	});

	test("ignores non-edit updates and disabled streaming abort", () => {
		const enabled = createGuard(true);
		enabled.guard.maybeAbort(previewEvent(false, [{ path: "a.ts", error: "bad" }], "read"));
		expect(enabled.aborts.count).toBe(0);

		const disabled = createGuard(false);
		disabled.guard.maybeAbort(previewEvent(false, [{ path: "a.ts", error: "bad" }]));
		expect(disabled.aborts.count).toBe(0);
	});

	test("reset permits a later final preview to abort", () => {
		const { guard, aborts } = createGuard(true);
		const event = previewEvent(false, [{ path: "a.ts", error: "bad" }]);
		guard.maybeAbort(event);
		guard.reset();
		guard.maybeAbort(event);
		expect(aborts.count).toBe(2);
	});
});
