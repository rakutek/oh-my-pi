import { EDIT_REASON_PREFIX, stripEditReason } from "@oh-my-pi/pi-tui/tools/edit-reason";

/** Only clone args when a reason actually changes their native payload. */
export function stripEditReasonArgs(args: unknown): unknown {
	if (!args || typeof args !== "object") return args;
	const fields = args as { input?: unknown; _input?: unknown };
	const input = typeof fields.input === "string" ? stripEditReason(fields.input) : fields.input;
	const rawInput = typeof fields._input === "string" ? stripEditReason(fields._input) : fields._input;
	if (input === fields.input && rawInput === fields._input) return args;
	let normalized = args;
	if (input !== fields.input) normalized = { ...normalized, input };
	if (rawInput !== fields._input) normalized = { ...normalized, _input: rawInput };
	return normalized;
}

/** Buffer only the ambiguous marker; discard the reason until its newline. */
export class EditReasonStream {
	#matched = 0;
	done = false;

	push(delta: string): string {
		if (this.done) return delta;
		let offset = 0;
		while (this.#matched < EDIT_REASON_PREFIX.length && offset < delta.length) {
			if (delta[offset] !== EDIT_REASON_PREFIX[this.#matched]) {
				this.done = true;
				return EDIT_REASON_PREFIX.slice(0, this.#matched) + delta.slice(offset);
			}
			this.#matched++;
			offset++;
		}
		if (this.#matched < EDIT_REASON_PREFIX.length) return "";
		const newline = delta.indexOf("\n", offset);
		if (newline < 0) return "";
		this.done = true;
		return delta.slice(newline + 1);
	}
}

/**
 * Remove the prefix from top-level input strings without reparsing the growing
 * JSON buffer. Other bytes pass through unchanged, including invalid JSON so
 * the native parser remains responsible for validation and error reporting.
 */
export class JsonEditReasonStream {
	#depth = 0;
	#inString = false;
	#isKey = false;
	#expectKey = false;
	#key = "";
	#keyToken = "";
	#escaped = false;
	#escape = "";
	#reason: EditReasonStream | undefined;

	push(delta: string): string {
		let start = 0;
		const output: string[] = [];
		for (let index = 0; index < delta.length; index++) {
			const char = delta[index];
			if (this.#inString) {
				if (this.#reason) {
					if (start < index) output.push(delta.slice(start, index));
					start = index + 1;
					if (char === '"' && !this.#escape) {
						this.#reason = undefined;
						this.#inString = false;
						output.push(char);
						continue;
					}
					if (char < " " && !this.#escape) {
						output.push(char);
						this.#reason = undefined;
						continue;
					}
					let decoded = char;
					if (this.#escape || char === "\\") {
						this.#escape += char;
						if (this.#escape.length === 1 || (this.#escape[1] === "u" && this.#escape.length < 6)) continue;
						try {
							decoded = JSON.parse(`"${this.#escape}"`) as string;
						} catch {
							// Preserve malformed escapes for the native parser to reject.
							output.push(this.#escape);
							this.#reason = undefined;
							this.#escape = "";
							continue;
						}
						this.#escape = "";
					}
					const payload = this.#reason.push(decoded);
					if (payload) output.push(JSON.stringify(payload).slice(1, -1));
					if (this.#reason.done) this.#reason = undefined;
					continue;
				}
				if (this.#isKey) this.#keyToken += char;
				if (this.#escaped) this.#escaped = false;
				else if (char === "\\") this.#escaped = true;
				else if (char === '"') {
					this.#inString = false;
					if (this.#isKey) {
						try {
							this.#key = JSON.parse(this.#keyToken) as string;
						} catch {
							this.#key = "";
						}
						this.#expectKey = false;
					}
				}
				continue;
			}
			if (char === '"') {
				this.#inString = true;
				this.#isKey = this.#depth === 1 && this.#expectKey;
				if (this.#isKey) this.#keyToken = '"';
				else if (this.#depth === 1 && (this.#key === "input" || this.#key === "_input")) {
					this.#reason = new EditReasonStream();
				}
			} else if (char === "{" || char === "[") {
				this.#depth++;
				if (this.#depth === 1) this.#expectKey = true;
			} else if (char === "}" || char === "]") this.#depth--;
			else if (char === "," && this.#depth === 1) this.#expectKey = true;
		}
		if (start === 0) return delta;
		if (start < delta.length) output.push(delta.slice(start));
		return output.join("");
	}
}
