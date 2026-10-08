export const EDIT_REASON_PREFIX = "*** Reason: ";

/** Read a purpose without removing it from the persisted tool call. */
export function getEditReason(args: { title?: unknown; input?: string; _input?: string }): string | undefined {
	if (typeof args.title === "string" && args.title.trim()) return args.title.trim();
	const input = args.input ?? args._input;
	if (!input?.startsWith(EDIT_REASON_PREFIX)) return undefined;
	const end = input.indexOf("\n", EDIT_REASON_PREFIX.length);
	return input.slice(EDIT_REASON_PREFIX.length, end < 0 ? undefined : end).trim() || undefined;
}

/** Hide an incomplete header, and leave historical unprefixed payloads untouched. */
export function stripEditReason(input: string): string {
	if (EDIT_REASON_PREFIX.startsWith(input)) return "";
	if (!input.startsWith(EDIT_REASON_PREFIX)) return input;
	const end = input.indexOf("\n", EDIT_REASON_PREFIX.length);
	return end < 0 ? "" : input.slice(end + 1);
}
