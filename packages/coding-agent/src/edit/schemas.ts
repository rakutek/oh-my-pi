import { type } from "@oh-my-pi/omptype";

export const replaceEditSchema = type({
	"title?": "string",
	path: "string",
	old_string: "string",
	new_string: "string",
	"replace_all?": "boolean",
});

export type ReplaceParams = typeof replaceEditSchema.infer;

/** Internal batch form produced only by the Cursor exec bridge. */
export interface ReplaceBatchParams {
	title?: string;
	path: string;
	edits: Omit<ReplaceParams, "path" | "title">[];
}

export const patchEditEntrySchema = type({
	"op?": "'create' | 'delete' | 'update'",
	"rename?": "string",
	"diff?": "string",
});

export type PatchEditEntry = typeof patchEditEntrySchema.infer;

export const patchEditSchema = type({
	"title?": "string",
	path: "string",
	edits: patchEditEntrySchema.array(),
});

export type PatchParams = typeof patchEditSchema.infer;

export const applyPatchSchema = type({
	"title?": "string",
	input: "string",
});

export type ApplyPatchParams = typeof applyPatchSchema.infer;

export const hashlineEditParamsSchema = type({
	"title?": "string",
	input: "string",
});

export type HashlineParams = typeof hashlineEditParamsSchema.infer;

export const sloppyEditSchema = type({
	"title?": "string",
	input: "string",
});

export type SloppyParams = typeof sloppyEditSchema.infer;
