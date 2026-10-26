// Types for compare.mjs (proofroom/compare), for TypeScript tests; named apart so they do not stand in for its own.

/** What compareSnapshot() judges: one snapshot of a project, or of a directory of baselines. */
export interface SnapshotOptions {
    /** A project of visual-review.config.json; its baselines and story settings files are read. */
    project?: string;
    /** A directory of baselines instead of a project's. */
    baselines?: string;
    /** The git checkout whose config names the project (default: the current one). */
    root?: string;
    /** The story or snapshot id: lowercase letters, digits and "-". */
    id: string;
    /** The mode, or null (default). */
    mode?: string | null;
    /** The PNG's bytes or its path; null when the snapshot could not be shot; or openCapture()'s shot, whose fields are the options. */
    image?: Uint8Array | string | null | Partial<SnapshotOptions>;
    type?: "image" | "failed" | "excluded";
    /** Why the snapshot could not be shot, or why it is excluded. */
    reason?: string | null;
    byStory?: boolean;
    console?: string[];
    /** The threshold (0..1) and anti-aliasing switch, where the story settings file sets none. */
    settings?: { threshold?: number; includeAA?: boolean };
    /** The default branch's capture, for "no baseline yet". */
    reference?: string | null;
    /** Where the result line and the images go (default: $PROOFROOM_OUT, else nowhere). */
    out?: string | null;
}

/** A results.json item plus its project, attempt and whether it passed. */
export interface ResultLine {
    project: string;
    id: string;
    mode: string | null;
    file: string;
    status: "unchanged" | "changed" | "moved" | "new" | "unseeded" | "removed" | "failed" | "excluded";
    attempt: number;
    passed: boolean;
    [field: string]: unknown;
}

export const DEFAULT_THRESHOLD: number;
export function compareSnapshot(options: SnapshotOptions): Promise<ResultLine | null>;
export function assertSnapshot(options: SnapshotOptions): Promise<ResultLine | null>;
