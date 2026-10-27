/*
 * Find in the snapshot list (design 4.1): text filters the rows across every group while the box
 * holds it; a number ("47" or "#47") is a jump to that snapshot, not a filter. Pure functions.
 */

/**
 * The snapshot number a Find text jumps to, or null when it is text to filter by.
 * @param {string} text the box's text
 * @returns {number | null} the number
 */
export function jumpOf(text) {
    const t = String(text).trim();
    return /^#?\d+$/.test(t) ? Number(t.replace("#", "")) : null;
}

/**
 * The filter a Find text is, or null when it filters nothing (empty, or a number).
 * @param {string} text the box's text
 * @returns {((s: { project: string, id: string, mode: string | null }) => boolean) | null}
 *     whether a snapshot matches
 */
export function filterOf(text) {
    const q = String(text).trim().toLowerCase();
    if (q === "" || jumpOf(q) !== null) {
        return null;
    }
    return (s) => `${s.project} ${s.id} ${s.mode ?? ""}`.toLowerCase().includes(q);
}
