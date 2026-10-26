/*
 * Which snapshots' diffs to work out ahead, so the one a key press goes to is drawn without
 * waiting: the targets of the keys that move on (Right, Accept's next undecided, Left, the next
 * group's first undecided), and how many diffs the page keeps.
 */

/**
 * How many diffs the page keeps, the one on screen included: a diff holds about 13 bytes per image
 * pixel, so a device that reports 4 GB of memory or less keeps 2, any other 4.
 * @returns {number} the number kept
 */
export function keptDiffs() {
    const memory = globalThis.navigator?.deviceMemory;
    return memory !== undefined && memory <= 4 ? 2 : 4;
}

/**
 * Whether a snapshot has a diff: both images, and a capture that did not fail.
 * @param {{ baseline?: string | null, capture?: string | null, status?: string }} item the snapshot
 * @returns {boolean} true when it has one
 */
export const diffable = (item) => Boolean(item?.baseline && item?.capture && item.status !== "failed");

/**
 * The snapshots a key press can go to from `index`, most likely first, each once and never the one
 * on screen: Right (the next), Accept's next undecided, Left (the one before) and the next group's
 * first undecided. Only those with a diff.
 * @param {object[]} items the snapshots in the order the keys walk them
 * @param {number} index the one on screen
 * @param {(item: object) => boolean} undecided whether a snapshot still needs a decision
 * @param {(item: object) => string} groupOf the group a snapshot is in
 * @returns {object[]} the targets, at most four
 */
export function targetsOf(items, index, undecided, groupOf) {
    const here = items[index];
    const after = items.slice(index + 1);
    const nextGroup = after.find((i) => groupOf(i) !== groupOf(here));
    const targets = [
        items[index + 1],
        after.find(undecided),
        items[index - 1],
        nextGroup && after.find((i) => groupOf(i) === groupOf(nextGroup) && undecided(i)),
    ];
    return [...new Set(targets)].filter((i) => i && i !== here && diffable(i));
}
