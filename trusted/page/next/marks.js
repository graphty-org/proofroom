/*
 * The status and decision marks (design 4.3): one table of words, shapes and colors, shared by the
 * list, its filters and group headers, and the viewer. Each status family has its own silhouette,
 * so the marks are told apart by shape alone and in grayscale; the word is always written beside
 * the shape, in --ink, and only the shape carries the color. No DOM here but the one mark builder.
 */

// One silhouette per meaning, 12 px, drawn in currentColor.
export const SHAPES = {
    changed: '<path d="M6 .8 11.2 6 6 11.2.8 6Z" fill="currentColor"/>',
    moved: '<path d="M6 1.3 10.7 6 6 10.7 1.3 6Z" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="6" cy="6" r="1.6" fill="currentColor"/>',
    new: '<circle cx="6" cy="6" r="5.5" fill="currentColor"/><path d="M6 3v6M3 6h6" stroke="#fff" stroke-width="1.6"/>',
    unseeded:
        '<circle cx="6" cy="6" r="5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-dasharray="2 1.6"/><path d="M6 3.4v5.2M3.4 6h5.2" stroke="currentColor" stroke-width="1.5"/>',
    removed:
        '<rect x=".7" y=".7" width="10.6" height="10.6" rx="2.6" fill="currentColor"/><path d="M3 6h6" stroke="#fff" stroke-width="1.8"/>',
    failed: '<path d="M6 .8 11.5 10.8H.5Z" fill="currentColor"/><path d="M6 4.2v3.4" stroke="#fff" stroke-width="1.4"/><circle cx="6" cy="9.1" r=".8" fill="#fff"/>',
    wavy: '<path d="M.8 7c1.3-3 2.7-3 4 0s2.7 3 4 0 1.8-2.4 2.4-2.4" fill="none" stroke="currentColor" stroke-width="1.5"/>',
    accept: '<path d="M1.8 6.3 4.7 9.1 10.3 3" fill="none" stroke="currentColor" stroke-width="1.9"/>',
    reject: '<circle cx="6" cy="6" r="5.2" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M4 4l4 4M8 4 4 8" stroke="currentColor" stroke-width="1.4"/>',
    exclude:
        '<circle cx="6" cy="6" r="5.2" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M2.4 9.6 9.6 2.4" stroke="currentColor" stroke-width="1.3"/>',
    before: '<circle cx="6" cy="6" r="5.4" fill="none" stroke="currentColor"/><circle cx="6" cy="6" r="3.8" fill="none" stroke="currentColor"/><path d="M4.3 6.1 5.5 7.3 7.8 4.8" fill="none" stroke="currentColor" stroke-width="1.1"/>',
    finished:
        '<path d="M1 6 3.4 8.4 7 4" fill="none" stroke="currentColor" stroke-width="1.6"/><rect x="7.6" y="7.2" width="4" height="3.8" rx=".6" fill="currentColor"/><path d="M8.5 7.3V6.2a1.1 1.1 0 0 1 2.2 0v1.1" fill="none" stroke="currentColor" stroke-width=".9"/>',
    // The disclosure mark: a chevron, down when open, right when closed (never + or -, the shapes of
    // new and removed).
    chevOpen: '<path d="M2.5 4.2 6 7.8 9.5 4.2" fill="none" stroke="currentColor" stroke-width="1.7"/>',
    chevClosed: '<path d="M4.2 2.5 7.8 6 4.2 9.5" fill="none" stroke="currentColor" stroke-width="1.7"/>',
};

/**
 * The statuses, in the one status order used everywhere: word, shape, color class, the viewer's
 * sentence for what Accept does, and whether Accept is allowed. "unstable" comes only from
 * captures made before one shot per snapshot; it is shown, never produced.
 */
export const STATUS = {
    failed: {
        word: "failed",
        shape: "failed",
        cls: "c-failed",
        say: "This story did not render. Fix the story or capture again; Exclude stops capturing it.",
        accept: false,
    },
    changed: {
        word: "changed",
        shape: "changed",
        cls: "c-changed",
        say: "Accept replaces the baseline with the new image.",
        accept: true,
    },
    moved: {
        word: "moved",
        shape: "moved",
        cls: "c-changed",
        say: "Accept renames the baseline; the image is identical.",
        accept: true,
    },
    new: { word: "new", shape: "new", cls: "c-new", say: "Accept makes this the first baseline.", accept: true },
    unseeded: {
        word: "no baseline yet",
        shape: "unseeded",
        cls: "c-new",
        say: "Accept makes this the first baseline. The story existed before but was never approved.",
        accept: true,
    },
    removed: {
        word: "removed",
        shape: "removed",
        cls: "c-removed",
        say: "Accept deletes this baseline.",
        accept: true,
    },
    unstable: {
        word: "unstable (old capture)",
        shape: "wavy",
        cls: "c-other",
        say: "Two shots of this story disagreed in an old capture. Exclude stops capturing it.",
        accept: false,
    },
};

/** The status order: lists, summaries, filters and group order follow it. */
export const ORDER = Object.keys(STATUS);

/** The decisions' marks and colors (design 4.3), shown beside the status, never in its place. */
export const DECISION = {
    accept: { shape: "accept", cls: "c-accept" },
    reject: { shape: "reject", cls: "c-reject" },
    exclude: { shape: "exclude", cls: "c-exclude" },
    before: { shape: "before", cls: "c-accept" },
    finished: { shape: "finished", cls: "c-ink2" },
};

/**
 * What a status allows: Accept, Reject and Exclude, or Exclude only (a failed or unstable story).
 * @param {string} status the status
 * @returns {("accept" | "reject" | "exclude")[]} the decisions
 */
export const decisionsFor = (status) =>
    STATUS[status]?.accept === false ? ["exclude"] : ["accept", "reject", "exclude"];

/**
 * A shape as an inline SVG element in a span: this module's own constants, never text from a pull
 * request.
 * @param {string} name a key of SHAPES
 * @param {string} [cls] the color class
 * @returns {HTMLElement} the mark
 */
export function mark(name, cls = "") {
    const key = `${name} ${cls}`;
    let made = made1.get(key);
    if (!made) {
        made = document.createElement("span");
        made.className = `ic ${cls}`;
        made.setAttribute("aria-hidden", "true");
        made.innerHTML = `<svg viewBox="0 0 12 12" width="12" height="12">${SHAPES[name]}</svg>`;
        made1.set(key, made);
    }
    // A copy of the one made for this shape and color: a list of 3,000 rows parses each SVG once.
    return /** @type {HTMLElement} */ (made.cloneNode(true));
}
const made1 = new Map();

/**
 * A status's mark and word, as the list, the summary and the viewer show it.
 * @param {string} status the status
 * @returns {HTMLElement} the mark and its word
 */
export function statusMark(status) {
    const s = STATUS[status] ?? { word: status, shape: "wavy", cls: "c-ink2" };
    const span = document.createElement("span");
    span.className = "st";
    span.append(mark(s.shape, s.cls), s.word);
    return span;
}
