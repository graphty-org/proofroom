/*
 * Which page test file presses which actions of the new page's action table. Each file checks,
 * after its tests, that it pressed every action listed for it (from the actions the page logged),
 * and actions.test.mjs checks that every action in the table is listed here: an action no test
 * presses fails the suite.
 */

export const COVERS = {
    "changes.page.test.mjs": [
        "screen-review",
        "refresh",
        "nextchange",
        "chgsort",
        "sort-needs",
        "sort-newest",
        "sort-most",
        "sort-author",
        "chgfind",
        "section",
        "pickchg",
        "openchg",
        "rowmenu",
        "about",
        "onhost",
        "copylink",
        "dismiss",
        "joblog",
        "summaryopen",
        "closebox",
        "messages",
        "usetoken",
    ],
    "keys.page.test.mjs": ["pane1", "pane2", "back", "openrow", "openchg", "nextchange", "chgfind"],
    "layout.page.test.mjs": ["pane1", "pane2", "back", "openrow", "pickrow"],
};
