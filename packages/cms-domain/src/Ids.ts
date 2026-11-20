import * as Schema from "effect/Schema";

export const WorkspaceId = Schema.String.pipe(Schema.brand("WorkspaceId"));
export type WorkspaceId = typeof WorkspaceId.Type;

export const DocumentId = Schema.String.pipe(Schema.brand("DocumentId"));
export type DocumentId = typeof DocumentId.Type;

export const SlotKey = Schema.String.pipe(Schema.brand("SlotKey"));
export type SlotKey = typeof SlotKey.Type;

export const Revision = Schema.Int;
export type Revision = typeof Revision.Type;
