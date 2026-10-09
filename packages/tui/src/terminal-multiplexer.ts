/** True when this process is running inside a Herdr pane. */
export function isInsideHerdr(env: NodeJS.ProcessEnv = Bun.env): boolean {
	// HERDR_ENV=1 is canonical. Identity vars survive env-sanitizing launchers
	// that drop HERDR_ENV. Do not use HERDR_SOCKET_PATH, HERDR_BIN_PATH,
	// HERDR_SESSION, HERDR_CONFIG_PATH, or HERDR_CLIENT_SOCKET_PATH here: they
	// are client-side and can be set outside a Herdr pane, matching the
	// CMUX_SOCKET_PATH warning below.
	if (env.HERDR_ENV === "1") return true;
	if (env.HERDR_PANE_ID || env.HERDR_TAB_ID || env.HERDR_WORKSPACE_ID) return true;
	return false;
}

/** Parse the leading `major.minor` of a self-reported terminal version (`TERM_PROGRAM_VERSION`). */
export function parseMajorMinorVersion(versionRaw?: string): { major: number; minor: number } | null {
	if (!versionRaw) return null;
	const match = /^(\d+)\.(\d+)/u.exec(versionRaw.trim());
	if (!match) return null;
	const major = Number.parseInt(match[1] ?? "", 10);
	const minor = Number.parseInt(match[2] ?? "", 10);
	if (!Number.isFinite(major) || !Number.isFinite(minor)) return null;
	return { major, minor };
}

/**
 * True when the enclosing Herdr pane renders Kitty graphics, including `U=1`
 * Unicode placeholders, by default.
 *
 * Herdr 0.9.0 enabled `terminal.kitty_graphics` by default and re-emits pane
 * images to compatible outer terminals itself. Its panes identify the release
 * through `TERM_PROGRAM=herdr` + `TERM_PROGRAM_VERSION`. Older or unversioned
 * panes, and screen/tmux nested inside a pane (tmux replaces `TERM_PROGRAM`;
 * screen cannot carry Kitty APC), stay off. A user-disabled
 * `terminal.kitty_graphics` is not visible from the pane environment;
 * `PI_FORCE_IMAGE_PROTOCOL=none` opts out.
 */
export function herdrRendersKittyGraphics(env: NodeJS.ProcessEnv = Bun.env): boolean {
	if (!isInsideHerdr(env) || env.STY || env.TMUX) return false;
	if (env.TERM_PROGRAM?.trim().toLowerCase() !== "herdr") return false;
	const version = parseMajorMinorVersion(env.TERM_PROGRAM_VERSION);
	return version !== null && (version.major > 0 || version.minor >= 9);
}

/** Terminal multiplexers omp recognizes as owning the screen grid. */
export type TerminalMultiplexer = "herdr" | "tmux" | "screen" | "zellij" | "cmux" | "wmux";

/**
 * Classify which terminal multiplexer owns the current screen grid, or `null`
 * for a direct terminal. Single source of truth for both the render-path gate
 * (`isInsideTerminalMultiplexer`) and the debug snapshot label.
 *
 * TMUX/STY/ZELLIJ, Herdr, and the CMUX/WMUX workspace/surface/remote-transport
 * markers are authoritative session signals. TERM can also survive when those
 * are stripped (`sudo` without -E, `su`, env-sanitizing launchers/ssh). Do not
 * use CMUX_SOCKET_PATH / WMUX_CLI / WMUX_PIPE here: they are CLI socket/path
 * overrides and can be set outside a CMUX/WMUX terminal. wmux is a Windows
 * multiplexer (Electron + xterm.js) modeled on cmux/herdr that repaints its
 * pane in place and exports WMUX=1 plus a native WMUX_SURFACE_ID.
 */
export function classifyTerminalMultiplexer(env: NodeJS.ProcessEnv = Bun.env): TerminalMultiplexer | null {
	if (isInsideHerdr(env)) return "herdr";
	if (env.TMUX) return "tmux";
	if (env.STY) return "screen";
	if (env.ZELLIJ) return "zellij";
	if (env.CMUX_WORKSPACE_ID || env.CMUX_SURFACE_ID || env.CMUX_REMOTE_TRANSPORT) return "cmux";
	if (env.WMUX === "1" || env.WMUX_SURFACE_ID) return "wmux";
	const term = env.TERM?.toLowerCase() ?? "";
	if (term.startsWith("tmux")) return "tmux";
	if (term.startsWith("screen")) return "screen";
	return null;
}

/** True when a terminal multiplexer owns the current screen grid. */
export function isInsideTerminalMultiplexer(env: NodeJS.ProcessEnv = Bun.env): boolean {
	return classifyTerminalMultiplexer(env) !== null;
}
