import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";
import { afterEach, describe, expect, it } from "bun:test";
import { TERMINAL, setTerminalHyperlinks } from "@oh-my-pi/pi-tui";
import { applyHyperlinkSetting } from "@oh-my-pi/pi-tui/render/hyperlink";
import * as themeModule from "@oh-my-pi/pi-tui/theme";
import { writeToolRenderer } from "@oh-my-pi/pi-tui/tools/write";

const ORIGINAL_HYPERLINKS = TERMINAL.hyperlinks;
const ORIGINAL_TERMINAL_ID = Object.getOwnPropertyDescriptor(TERMINAL, "id");

afterEach(() => {
	applyHyperlinkSetting("auto");
	if (ORIGINAL_TERMINAL_ID) Object.defineProperty(TERMINAL, "id", ORIGINAL_TERMINAL_ID);
	setTerminalHyperlinks(ORIGINAL_HYPERLINKS);
});

describe("pending write path rendering", () => {
	it("keeps an untrusted purpose on one bounded row through write progress and failure", async () => {
		await themeModule.initTheme();
		const uiTheme = (await themeModule.getThemeByName("dark")) ?? (await themeModule.getThemeByName("light"));
		if (!uiTheme) throw new Error("expected an initialized theme");
		const args = {
			path: "config.ts",
			content: "export const retries = 3;\n",
			i: `設定を統一\nするため\t\x1b[2J\x07${"説明".repeat(50)}`,
		};
		const options = { expanded: false, isPartial: true };
		const components = [
			writeToolRenderer.renderCall(args, options, uiTheme),
			writeToolRenderer.renderResult({ content: [{ type: "text", text: "Writing..." }] }, options, uiTheme, args),
			writeToolRenderer.renderResult({ content: [] }, { ...options, isPartial: false }, uiTheme, args),
			writeToolRenderer.renderResult(
				{ content: [{ type: "text", text: "Disk full" }], isError: true },
				{ ...options, isPartial: false },
				uiTheme,
				args,
			),
		];
		for (const component of components) {
			if (!component) throw new Error("expected a file write card");
			for (const width of [40, 80]) {
				const lines = component.render(width);
				const plain = lines.map(line => Bun.stripANSI(line));
				expect(plain.filter(line => line.includes("設定を統一 するため"))).toHaveLength(1);
				expect(plain.join("\n")).toContain("config.ts");
				expect(lines.join("\n")).not.toContain("\x1b[2J");
				expect(plain.join("\n")).not.toMatch(/[\x07\t]/);
				for (const line of lines) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(width);
			}
		}
		const routedArgs = { path: "proc://worker", content: "continue" };
		expect(writeToolRenderer.activitySummary({ ...routedArgs, i: args.i }, options)).toEqual(
			writeToolRenderer.activitySummary(routedArgs, options),
		);
	});

	it("links a relative path before the write result exists", async () => {
		applyHyperlinkSetting("always");
		await themeModule.initTheme();
		const uiTheme = (await themeModule.getThemeByName("dark")) ?? (await themeModule.getThemeByName("light"));
		if (!uiTheme) throw new Error("expected an initialized theme");
		const relativePath = ".tricky/reports/pending/interval.json";
		const component = writeToolRenderer.renderCall(
			{ path: relativePath, content: '{"status":"pending"}' },
			{ expanded: false, isPartial: true, spinnerFrame: 0 },
			uiTheme,
		);
		if (!component) throw new Error("expected a rendered component for a non-xdev write path");

		const rendered = component.render(120).join("\n");
		const target = rendered.match(/\x1b\]8;[^;]*;([^\x1b]+)\x1b\\/)?.[1];
		expect(target).toBeDefined();
		expect(target).toMatch(/^file:/);
		expect(decodeURIComponent(new URL(target!).pathname)).toEndWith(`/${relativePath}`);
	});

	it("uses the absolute filesystem target in VS Code", async () => {
		applyHyperlinkSetting("always");
		Object.defineProperty(TERMINAL, "id", { value: "vscode", configurable: true });
		await themeModule.initTheme();
		const uiTheme = (await themeModule.getThemeByName("dark")) ?? (await themeModule.getThemeByName("light"));
		if (!uiTheme) throw new Error("expected an initialized theme");
		const relativePath = ".tricky/reports/pending/interval.json";
		const component = writeToolRenderer.renderCall(
			{ path: relativePath, content: "ready" },
			{ expanded: false, isPartial: true },
			uiTheme,
		);
		const rendered = component?.render(120).join("\n");
		// vscode://file takes the forward-slash path (`/C:/…` on Windows).
		expect(rendered).toContain(`vscode://file${url.pathToFileURL(path.resolve(relativePath)).pathname}`);
	});

	it("links archive members, database rows, and home paths to their files", async () => {
		applyHyperlinkSetting("always");
		await themeModule.initTheme();
		const uiTheme = (await themeModule.getThemeByName("dark")) ?? (await themeModule.getThemeByName("light"));
		if (!uiTheme) throw new Error("expected an initialized theme");
		for (const [input, containingFile] of [
			["reports.zip:entries/data.json", "reports.zip"],
			["records.sqlite:users:42", "records.sqlite"],
			["~/notes/todo.md", path.join(os.homedir(), "notes/todo.md")],
		]) {
			const component = writeToolRenderer.renderCall(
				{ path: input, content: "ready" },
				{ expanded: false, isPartial: true },
				uiTheme,
			);
			const target = component
				?.render(120)
				.join("\n")
				.match(/\x1b\]8;[^;]*;([^\x1b]+)\x1b\\/)?.[1];
			expect(target).toBeDefined();
			expect(url.fileURLToPath(target!)).toBe(path.resolve(containingFile));
		}
	});

	it("does not link an unfinished streamed path", async () => {
		applyHyperlinkSetting("always");
		await themeModule.initTheme();
		const uiTheme = (await themeModule.getThemeByName("dark")) ?? (await themeModule.getThemeByName("light"));
		if (!uiTheme) throw new Error("expected an initialized theme");
		const partial = writeToolRenderer.renderCall(
			{ path: "reports/incom" },
			{ expanded: false, isPartial: true },
			uiTheme,
		);
		expect(partial?.render(120).join("\n")).not.toContain("\x1b]8;");
		const settled = writeToolRenderer.renderCall(
			{ path: "reports/incomplete.txt", content: "" },
			{ expanded: false, isPartial: true },
			uiTheme,
		);
		expect(settled?.render(120).join("\n")).toContain("\x1b]8;");
	});
});
