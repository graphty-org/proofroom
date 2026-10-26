/*
 * The changes and rows the new page's tests and its bench show: target summaries and row lists
 * shaped as GET /api/prs and GET /api/pr give them, with every row state of the design's
 * section 3.5. Plain data, no test runner, so bench/ can use it too.
 */

export const NOW = Date.UTC(2026, 9, 26, 12, 0, 0);

/**
 * One project of a target summary, ready with `reviewable` snapshots, as GET /api/prs lists it.
 * @param {string} project the project
 * @param {object} [over] fields to change
 * @returns {object} the project summary
 */
export function project(project, over = {}) {
    const reviewable = over.reviewable ?? 0;
    return {
        project,
        problem: null,
        downloading: false,
        bytes: null,
        logUrl: `https://gh/job/${project}`,
        ci: { status: "completed", conclusion: "success" },
        counts: reviewable > 0 ? { changed: reviewable } : {},
        failed: [],
        reviewable,
        decided: 0,
        undecided: reviewable,
        finished: 0,
        rejected: 0,
        notOpened: 0,
        acceptable: true,
        local: null,
        preview: false,
        pending: false,
        newer: [],
        ...over,
    };
}

/**
 * A pull request's target summary.
 * @param {number} pr its number
 * @param {object} [over] fields to change; `projects` replaces the projects
 * @returns {object} the summary
 */
export function target(pr, over = {}) {
    return {
        id: String(pr),
        pr,
        local: false,
        title: `Change ${pr}`,
        url: `https://gh/pull/${pr}`,
        branch: `feat/${pr}-change`,
        draft: false,
        runId: 1000 + pr,
        runAttempt: 1,
        runUrl: `https://gh/runs/${1000 + pr}`,
        commit: "6dfc21d0aa",
        headSha: "6dfc21d0aa",
        author: "octocat",
        readyAt: new Date(NOW - 4 * 60000).toISOString(),
        behind: null,
        stale: 0,
        lookOnly: false,
        newerRun: null,
        pendingPush: null,
        downloading: false,
        download: null,
        defaultBranch: "master",
        unpublished: 0,
        warnings: [],
        projects: [project("graphty-element", { reviewable: 3 })],
        ...over,
    };
}

/**
 * Fifty changes in every row state of the design's section 3.5, with their row lists.
 * @returns {object[]} the summaries
 */
export function fiftyChanges() {
    const t = [];
    const add = (pr, over) => t.push(target(pr, over));
    const decided = (n, d) => project("graphty-element", { reviewable: n, decided: d, undecided: n - d });
    add(3486, {
        title: "Storybook 9 upgrade",
        author: "apowers",
        projects: [project("graphty-element", { reviewable: 300 })],
    });
    add(3485, { behind: "master", projects: [project("graphty-element", { reviewable: 12 })] });
    add(3484, {
        title: "Legend overlay",
        author: "mlin",
        branch: "fix/legend-overlay",
        projects: [project("graphty-element", { reviewable: 3 })],
    });
    add(3483, { stale: 3, projects: [project("graphty-element", { reviewable: 18 })] });
    add(3482, { projects: [decided(60, 31)] });
    add(3481, { pendingPush: "abc1234", projects: [project("graphty-element", { reviewable: 7 })] });
    add(3480, { projects: [decided(9, 9)], unpublished: 9 });
    add(3479, { projects: [decided(31, 31)], unpublished: 31 });
    add(3478, {
        downloading: true,
        download: { done: 2, total: 3, bytesDone: 68e6, bytes: 99e6, startedAt: NOW },
        projects: ["a", "b", "c"].map((p) => project(p, { downloading: true })),
    });
    add(3477, {
        projects: [
            project("graphty-element", {
                problem: "CI still running; reload when it finishes",
                ci: { status: "in_progress", conclusion: null },
            }),
            project("graphty", { reviewable: 4 }),
            project("compact-mantine", { reviewable: 2 }),
        ],
    });
    add(3476, {
        projects: [
            project("graphty", {
                reviewable: 5,
                failed: [
                    { id: "a--b", mode: null, reason: "timeout" },
                    { id: "a--c", mode: null, reason: "timeout" },
                    { id: "a--d", mode: null, reason: "timeout" },
                ],
            }),
        ],
    });
    add(3475, {
        projects: [
            project("graphty-element", { problem: "artifact expired: re-run the visual job" }),
            project("graphty", { reviewable: 2 }),
            project("x", { reviewable: 1 }),
        ],
    });
    add(3474, {
        projects: [project("graphty-element", { reviewable: 4, decided: 4, undecided: 0, finished: 4 })],
        unpublished: 0,
    });
    add(3473, { projects: [project("graphty-element", { reviewable: 0 })] });
    add(3472, { draft: true, projects: [project("graphty-element", { reviewable: 5 })] });
    // A local preview: look only.
    t.push(
        target(0, {
            id: "local",
            pr: null,
            local: true,
            title: "local preview of /tmp/captures",
            url: null,
            branch: null,
            author: null,
            lookOnly: true,
            projects: [project("graphty-element", { reviewable: 22, preview: true })],
        }),
    );
    // The default branch's seed.
    t.push(
        target(0, {
            id: "master",
            pr: null,
            title: "master",
            url: null,
            branch: null,
            projects: [project("graphty-element", { reviewable: 12 })],
        }),
    );
    // A preview of a pull request waiting for CI.
    add(3471, {
        title: "Group padding race",
        projects: [
            project("graphty-element", {
                reviewable: 26,
                preview: true,
                ci: { status: "in_progress", conclusion: null },
            }),
        ],
    });
    let pr = 3400;
    while (t.length < 50) {
        const n = t.length;
        add(
            pr--,
            n % 3 === 0
                ? { projects: [project("graphty-element", { reviewable: 0 })] }
                : { projects: [decided(4, 4)], unpublished: 0 },
        );
    }
    return t;
}

/**
 * The changes list's answer, as GET /api/prs gives it.
 * @param {object[]} targets the summaries
 * @param {object} [over] fields to change (inbox, error, ...)
 * @returns {object} the answer
 */
export const listAnswer = (targets, over = {}) => ({
    targets,
    inbox: null,
    warning: null,
    defaultBranch: "master",
    repository: "graphty-monorepo",
    updatedAt: NOW - 40000,
    now: NOW,
    refreshing: null,
    error: null,
    network: null,
    ...over,
});

const STATUSES = ["changed", "moved", "new", "unseeded", "removed", "failed"];

// A 64-digit hex hash, distinct per letter and number.
const hash = (letter, i) => `${letter}${i.toString(16)}`.padEnd(64, letter);

/**
 * One row of a project's list as GET /api/pr?rows=1 gives it: its images' hashes, its picture's
 * name and, for a change, its size and areas.
 * @param {number} i its place
 * @param {string} status its status
 * @param {object} [over] fields to change
 * @returns {object} the row
 */
export function row(i, status, over = {}) {
    const component = over.component ?? `component-${Math.floor(i / 5)}`;
    const mode = i % 2 ? "dark" : "light";
    const id = `${component}--story-${i}`;
    const baseline = ["changed", "removed", "moved", "unstable"].includes(status) ? hash("a", i) : null;
    const capture = status === "moved" ? baseline : ["removed", "failed"].includes(status) ? null : hash("b", i);
    const rest = { ...over };
    delete rest.component;
    return {
        id,
        mode,
        file: `${id}.${mode}.png`,
        status,
        ...(status === "moved" && { from: `${component}--old-story-${i}` }),
        baseline,
        capture,
        size: [800, 600],
        baselineSize: [800, 600],
        changedPixels: status === "changed" ? 100 + i * 37 : null,
        pic: status === "failed" ? null : `${baseline ?? "none"}-${capture ?? "none"}-0.1-0`,
        areas:
            status === "changed"
                ? { crop: [0, 0, 400, 156], zoom: i % 4 === 0 ? 1.5 : 3 + (i % 5), count: 1 + (i % 7) }
                : null,
        ...rest,
    };
}

/**
 * A project's rows, as GET /api/pr/<id>/<project>?rows=1 gives them.
 * @param {string} name the project
 * @param {number} n how many
 * @param {(i: number) => string} [statusOf] each row's status
 * @returns {object} the answer
 */
export function rowsAnswer(
    name,
    n,
    statusOf = (i) => (n <= 3 ? ["changed", "new", "removed"][i] : STATUSES[i % STATUSES.length]),
) {
    return {
        project: name,
        items: Array.from({ length: n }, (_, i) => row(i, statusOf(i))),
        decisions: {},
        clusters: [],
    };
}

/**
 * A project's rows with something of every kind the list shows: a component of 60 (over 50, so it
 * opens collapsed, named to sort after the others so it is not the first group), identical changes (one pair of images in eight rows), a look-alike cluster,
 * decisions of every kind (accepted, accepted unopened, approved before, rejected, rejected before,
 * excluded, finished), a re-review, a size change, a moved story and an unstable one from an old
 * capture.
 * @param {string} name the project
 * @param {number} [n] how many rows (at least 180)
 * @returns {object} the answer
 */
export function richRows(name, n = 180) {
    const items = Array.from({ length: n }, (_, i) => {
        const status = i === 3 ? "unstable" : STATUSES[i % STATUSES.length];
        return row(i, status, i >= 60 ? {} : { component: "widgets" });
    });
    // Eight changes of exactly the same pair of images.
    const same = items.filter((x) => x.status === "changed" && x.id.startsWith("component-")).slice(0, 8);
    for (const x of same) {
        x.baseline = hash("c", 0);
        x.capture = hash("d", 0);
        x.pic = `${x.baseline}-${x.capture}-0.1-0`;
    }
    const changed = items.filter((x) => x.status === "changed" && !same.includes(x));
    const look = changed.slice(-6);
    const at = (k) => changed[k];
    at(0).reReview = true;
    at(1).size = [800, 640];
    const d = (x, decision) => [x.file, decision];
    const decisions = Object.fromEntries([
        d(at(2), { decision: "accept", reason: null }),
        d(at(3), { decision: "accept", reason: null, bulk: true }),
        d(at(4), {
            decision: "accept",
            reason: null,
            approvedBefore: { pr: 1356, reviewedAt: "2026-10-01T00:00:00Z" },
        }),
        d(at(5), {
            decision: "accept",
            reason: null,
            approvedBefore: { pr: 1356, reviewedAt: "2026-10-01T00:00:00Z" },
        }),
        d(at(6), { decision: "reject", reason: "Legend overlaps the minimap at the right edge" }),
        d(at(7), { decision: "reject", reason: "The label wraps under the icon", posted: true }),
        d(at(8), { decision: "exclude", reason: "Animated: never stable" }),
        d(at(9), { decision: "accept", reason: null, posted: true }),
    ]);
    return {
        project: name,
        items,
        decisions,
        clusters: [
            {
                signature: "pixels top-left small",
                files: look.map((x) => x.file),
                representative: look[2].file,
                pixels: [look[0].changedPixels, look.at(-1).changedPixels],
            },
        ],
    };
}
