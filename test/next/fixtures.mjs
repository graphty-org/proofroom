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

/**
 * A project's rows, as GET /api/pr/<id>/<project>?rows=1 gives them.
 * @param {string} name the project
 * @param {number} n how many
 * @returns {object} the answer
 */
export function rowsAnswer(name, n) {
    return {
        project: name,
        items: Array.from({ length: n }, (_, i) => ({
            id: `component-${Math.floor(i / 5)}--story-${i}`,
            mode: i % 2 ? "dark" : "light",
            file: `component-${Math.floor(i / 5)}--story-${i}.${i % 2 ? "dark" : "light"}.png`,
            status: n <= 3 ? ["changed", "new", "removed"][i] : STATUSES[i % STATUSES.length],
            pic: null,
            areas: null,
        })),
        decisions: {},
        clusters: [],
    };
}
