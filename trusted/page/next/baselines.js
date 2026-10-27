/*
 * The Baselines screen (design 9.3): Projects (the ref picker and each project's components), the
 * Baselines list (the same rows as the snapshot list, with a plain picture) and the viewer of one
 * baseline with its history. The panes work as Review's: Hide [Shift+1] and [Shift+2], their
 * rails, Image only [Shift+3]. The viewer is viewer.js's, with its own item line, a bar of Previous
 * and Next only, and the history under it; ticking two versions compares them in the four views.
 *
 * The screen acts for the page through `host`, an object that stands for the page (app.js) on
 * this screen: the controls it builds run their actions on it, so View, Zoom and the pane keys
 * reach this screen's viewer and panes, never Review's.
 */

import { control, runAction } from "./actions.js";
import { api } from "./api.js";
import { componentOf, storyOf } from "./groups.js";
import { syncHints } from "./keys.js";
import { PANES, applyPanes, keepFloor, remember, remembered, shownNow, togglePane } from "./panes.js";
import { el, fmt, kb, megabytes } from "./ui.js";
import { createViewer } from "./viewer.js";

const $ = (id) => document.getElementById(id);
// Puts children in a node in place of its own: nested lists flattened, null and false left out.
const fill = (node, ...kids) =>
    node.replaceChildren(...kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false));
const IDS = PANES.baselines;
const NAMES = ["Projects", "Baselines"];
const GROUPS = { component: "Component", project: "Project", none: "None" };
const VIEW_NAME = { side: "Side by side", flash: "Flash", highlight: "Highlight", spotlight: "Spotlight" };
// A version's name in the history and on the frames: the current one, the one before, the first.
const versionName = (i, n) => (i === 0 ? "current" : i === n - 1 ? "first" : i === 1 ? "previous" : "earlier");
const changeName = (c) => (c ? (/^pr:\d+$/.test(c) ? `#${c.slice(3)}` : c.replace(/^[a-z]+:/, "")) : null);

/**
 * Sets up the Baselines screen for the page.
 * @param {any} app the page
 * @returns {object} the screen (app.baselines)
 */
export function installBaselines(app) {
    const st = {
        list: null, // the last GET /api/baselines answer
        items: [], // its baselines, numbered
        ref: "", // the change whose baselines are shown; "" for the default branch
        loading: null,
        failed: null,
        proj: null,
        comp: null,
        group: "component",
        cur: null, // the current baseline's key
        hist: new Map(), // each baseline's history answer (or its request), by ref and path
        cmp: [], // the two versions compared, as indices into the history
        busy: false, // a download running
        built: null, // what the list's rows were built for
        rowEls: new Map(),
        vsnap: null,
    };
    const host = Object.create(app);

    // ------------------------------------------------------------ the model

    function itemsOf(answer) {
        return answer.items.map((i, n) => {
            const [id, mode = null] = i.file.slice(0, -".png".length).split(".");
            return {
                ...i,
                n: n + 1,
                key: `${i.project}/${i.file}`,
                path: `${answer.baselines}/${i.project}/${i.file}`,
                id,
                mode,
                component: componentOf(id),
                name: storyOf(id),
            };
        });
    }
    const findText = () => $("bl-find").value.trim().toLowerCase();
    // The rows Projects and Find keep, in group order.
    function rows() {
        const q = findText();
        const num = /^#?(\d+)$/.exec(q);
        const kept = st.items.filter(
            (b) =>
                (!st.proj || b.project === st.proj) &&
                (!st.comp || b.component === st.comp) &&
                (!q || (num ? b.n === Number(num[1]) : `${b.component} ${b.name} ${b.id}`.toLowerCase().includes(q))),
        );
        const g = groupOf;
        return st.group === "none" ? kept : [...kept].sort((a, b) => (g(a) < g(b) ? -1 : g(a) > g(b) ? 1 : a.n - b.n));
    }
    const groupOf = (b) =>
        st.group === "component" ? `${b.project} > ${b.component}` : st.group === "project" ? b.project : "";
    const current = () => st.items.find((b) => b.key === st.cur) ?? null;
    const histKey = (b) => `${st.ref}|${b.path}`;
    const historyOf = (b) => {
        const h = b && st.hist.get(histKey(b));
        return h && !(h instanceof Promise) ? h : null;
    };

    // ------------------------------------------------------------ loading

    async function load() {
        const seq = (st.loading = Symbol("load"));
        st.failed = null;
        draw();
        try {
            const answer = await api(`/api/baselines${st.ref ? `?${new URLSearchParams({ ref: st.ref })}` : ""}`);
            if (st.loading !== seq) {
                return;
            }
            st.list = answer;
            st.items = itemsOf(answer);
            st.built = null;
            if (!current()) {
                st.cur = rows()[0]?.key ?? null;
                st.cmp = [];
            }
        } catch (err) {
            if (st.loading === seq) {
                st.failed = err.message;
                app.say(`The baselines could not be read: ${err.message}`, "err", [
                    control(host, "retry", { zone: "msgline", ctx: { run: () => load() } }),
                ]);
            }
        }
        if (st.loading === seq) {
            st.loading = null;
            draw();
        }
    }

    // One baseline's history, asked once when it is first viewed.
    function loadHistory(b) {
        const key = histKey(b);
        if (st.hist.has(key)) {
            return;
        }
        const q = new URLSearchParams({ path: b.path, ...(st.ref && { ref: st.ref }) });
        const asked = api(`/api/baselines/history?${q}`).then(
            (answer) => {
                st.hist.set(key, answer);
                if (current()?.key === b.key) {
                    draw();
                }
            },
            (err) => {
                st.hist.set(key, { error: err.message });
                if (current()?.key === b.key) {
                    draw();
                }
            },
        );
        st.hist.set(key, asked);
    }

    // ------------------------------------------------------------ the panes

    const at = () => ({ width: innerWidth, open: true, holds: true, ids: IDS });
    function layout() {
        const want = remembered(0, 1, "baselines") ?? [true, true];
        applyPanes(keepFloor(want, { ...at(), prefer: want[1] ? IDS[1] : IDS[0] }), at());
    }
    function toggle(i) {
        const { shown, moved } = togglePane(shownNow(IDS), IDS[i], at());
        applyPanes(shown, at());
        remember(0, 1, shown, "baselines");
        app.say(
            shown[i]
                ? `${NAMES[i]} shown.${moved ? ` ${NAMES[1 - i]} moved to its rail so the viewer keeps 800 px.` : ""}`
                : `${NAMES[i]} hidden: its rail or Shift+${i + 1} brings it back.`,
        );
        draw();
    }

    // ------------------------------------------------------------ drawing

    function drawProjects() {
        const count = new Map();
        for (const b of st.items) {
            count.set(b.project, (count.get(b.project) ?? 0) + 1);
            count.set(`${b.project}>${b.component}`, (count.get(`${b.project}>${b.component}`) ?? 0) + 1);
        }
        const projects = [...new Set(st.items.map((b) => b.project))].sort();
        $("rail-p").replaceWith(
            control(host, "pane1", {
                zone: "changes-head",
                ctx: { rail: true },
                attrs: { id: "rail-p", class: "railbar", title: "Show Projects (Shift+1)" },
                children: [
                    el("span", { class: "count" }, String(projects.length || "")),
                    el("span", { class: "vt" }, "Projects"),
                    kb("Shift+1"),
                ],
            }),
        );
        $("hide-p").replaceChildren(control(host, "pane1", { zone: "changes-head" }));
        const select = el(
            "select",
            { id: "bl-ref", "data-act": "blref", "data-zone": "changes-head" },
            el("option", { value: "" }, `${app.list?.defaultBranch ?? "master"} (default branch)`),
            app.changes.filter((c) => c.kind === "PR").map((c) => el("option", { value: c.id }, `#${c.pr} ${c.title}`)),
        );
        select.value = st.ref;
        select.addEventListener("change", () => runAction(host, "blref", { value: select.value }, "pointer"));
        $("bl-ref-slot").replaceChildren(select);
        const node = (label, n, project, component, sub = false) =>
            control(host, "blnode", {
                zone: "rows",
                tag: "div",
                ctx: { project, component },
                attrs: {
                    class: `node ${sub ? "sub" : ""} ${st.proj === project && st.comp === component ? "cur" : ""}`,
                    role: "option",
                },
                children: [
                    el(sub ? "span" : "b", { class: "grow" }, label),
                    el("span", { class: "num muted" }, fmt(n)),
                ],
            });
        fill(
            $("bl-tree"),
            node("Every project", st.items.length, null, null),
            projects.map((p) => [
                node(p, count.get(p), p, null),
                [...new Set(st.items.filter((b) => b.project === p).map((b) => b.component))]
                    .sort()
                    .map((c) => node(c, count.get(`${p}>${c}`), p, c, true)),
            ]),
        );
    }

    function drawHead(shown) {
        const missing = shown.filter((b) => !b.local);
        $("rail-b").replaceWith(
            control(host, "pane2", {
                zone: "snaps-head",
                ctx: { rail: true },
                attrs: { id: "rail-b", class: "railbar", title: "Show Baselines (Shift+2)" },
                children: [
                    el("span", { class: "count" }, fmt(shown.length)),
                    el("span", { class: "vt" }, "Baselines"),
                    kb("Shift+2"),
                ],
            }),
        );
        $("bl-title").replaceChildren(
            el("span", { class: "grow ell" }, st.comp ? `${st.proj} > ${st.comp}` : (st.proj ?? "Every project")),
            el("span", { class: "small muted num" }, `${fmt(shown.length)} baselines`),
            control(host, "pane2", { zone: "snaps-head" }),
        );
        fill(
            $("bl-ctrl"),
            control(host, "blgroupmenu", { zone: "snaps-head" }),
            missing.length > 0
                ? control(host, "bldl", {
                      zone: "snaps-head",
                      ctx: { paths: missing.map((b) => b.path) },
                      attrs: { class: "primary" },
                      label: `Download ${fmt(missing.length)} images (${megabytes(missing.reduce((n, b) => n + b.bytes, 0))})`,
                  })
                : null,
        );
    }

    function pictureOf(b) {
        const chip = (...c) => el("div", { class: "ph" }, el("span", {}, ...c));
        if (!b.local) {
            return el("div", { class: "pic" }, chip("Not downloaded"));
        }
        const box = el("div", { class: "pic" }, chip("Making picture..."));
        const img = el("img", { alt: "", loading: "lazy", decoding: "async", src: `/api/baselines/pic/${b.hash}` });
        img.addEventListener("load", () => box.classList.add("ready"));
        img.addEventListener("error", () => {
            img.remove();
            box.querySelector(".ph").replaceWith(chip("Picture failed."));
        });
        box.append(img);
        return box;
    }

    function rowOf(b) {
        return control(host, "blrow", {
            zone: "rows",
            tag: "div",
            ctx: { key: b.key },
            attrs: {
                class: `srow blrow ${b.key === st.cur ? "cur" : ""}`,
                "data-bl": b.key,
                role: "option",
                "aria-selected": b.key === st.cur ? "true" : "false",
                title: `#${b.n} ${b.project} > ${b.component} / ${b.name}${b.mode ? ` (${b.mode})` : ""}`,
            },
            children: [
                pictureOf(b),
                el(
                    "div",
                    { class: "info" },
                    el(
                        "div",
                        { class: "l" },
                        el("span", { class: "nmb" }, `#${b.n}`),
                        el("span", { class: "ell" }, `${b.component} / ${b.name}`),
                        b.mode ? el("span", { class: "tag" }, b.mode) : null,
                    ),
                    el("div", { class: "l small muted" }, `${b.project} > ${b.component}`),
                    el(
                        "div",
                        { class: "l small muted" },
                        b.at
                            ? `Last changed ${b.at.slice(0, 10)}${b.change ? ` in ${changeName(b.change)}` : ""}`
                            : "No approval record found",
                    ),
                ),
            ],
        });
    }

    function drawRows(shown) {
        const list = $("bl-list");
        const sig = JSON.stringify([st.list?.sha, st.ref, st.proj, st.comp, findText(), st.group, st.items.length]);
        if (sig === st.built) {
            for (const [key, r] of st.rowEls) {
                r.classList.toggle("cur", key === st.cur);
                r.setAttribute("aria-selected", key === st.cur ? "true" : "false");
            }
            return;
        }
        st.built = sig;
        st.rowEls = new Map();
        if (st.loading && st.items.length === 0) {
            list.replaceChildren(el("p", { class: "muted lempty" }, "Loading the baselines..."));
            return;
        }
        if (shown.length === 0) {
            const q = $("bl-find").value.trim();
            list.replaceChildren(
                el("p", { class: "muted lempty" }, q ? `No story matches "${q}".` : "No baselines here."),
            );
            return;
        }
        const out = [];
        let last = null;
        for (const b of shown) {
            const g = groupOf(b);
            if (g && g !== last) {
                out.push(el("div", { class: "ghead" }, el("span", { class: "gname1" }, g)));
                last = g;
            }
            const r = rowOf(b);
            st.rowEls.set(b.key, r);
            out.push(r);
        }
        list.replaceChildren(...out);
    }

    // What the viewer shows: the current baseline alone, or two of its versions, older on the left.
    function viewSnap(b) {
        const h = historyOf(b);
        const vers = h?.versions ?? [];
        const two = st.cmp.length === 2 && vers.length > 0;
        const [newer, older] = two ? [...st.cmp].sort((x, y) => x - y).map((i) => vers[i]) : [];
        const key = two ? `${b.key}|${older.hash}|${newer.hash}` : `${b.key}|${b.hash}`;
        if (st.vsnap?.key !== key) {
            st.vsnap = {
                key,
                n: b.n,
                project: b.project,
                component: b.component,
                name: b.name,
                mode: b.mode,
                file: b.file,
                id: b.id,
                status: two ? "changed" : "new",
                baseline: two ? older.hash : null,
                capture: two ? newer.hash : b.hash,
                names: two
                    ? [versionName(vers.indexOf(older), vers.length), versionName(vers.indexOf(newer), vers.length)]
                    : null,
                scale: 1,
            };
        }
        return st.vsnap;
    }

    function labels(s, view, vs) {
        if (!s.names) {
            return { rightLabel: "Current baseline" };
        }
        const [a, c] = s.names;
        const note = vs.space ? "flashing while Space is held" : "alternating, about 1.5 times a second";
        if (view === "flash") {
            return { rightLabel: a, flash: [a, c], note };
        }
        if (view === "spotlight" && (vs.spotFlash || vs.space)) {
            return { rightLabel: `Spotlit ${a}`, flash: [`Spotlit ${a}`, `Spotlit ${c}`], note };
        }
        return { leftLabel: a, rightLabel: view === "spotlight" ? `Spotlit ${c}` : c };
    }

    function fillLine(line, s) {
        line.className = "iline";
        fill(
            line,
            el("b", { class: "num" }, `#${s.n}`),
            el("b", { class: "name ell" }, `${s.component} / ${s.name}`),
            s.mode ? el("span", { class: "tag" }, s.mode) : null,
            el("span", { class: "muted ell comp" }, `${s.project} > ${s.component}`),
            el(
                "span",
                { class: "muted grow iright" },
                s.names
                    ? `Comparing the ${s.names[0]} version (left) with the ${s.names[1]} version (right)`
                    : "The current baseline",
            ),
        );
    }

    function fillBar(bar) {
        const shown = rows();
        const b = current();
        bar.replaceChildren(
            control(host, "prev", {
                zone: "decision",
                children: [el("span", { class: "lbl" }, "Previous"), kb("Left / J")],
            }),
            el(
                "span",
                { class: "pos num small" },
                el("b", {}, `#${b.n}`),
                ` ${fmt(shown.indexOf(b) + 1)} of ${fmt(shown.length)} baselines`,
            ),
            control(host, "next", {
                zone: "decision",
                children: [el("span", { class: "lbl" }, "Next"), kb("Right / K")],
            }),
        );
    }

    const histEl = el("div", { class: "hist", id: "bl-hist" });
    function fillHistory(b) {
        const h = st.hist.get(histKey(b));
        const head = el(
            "div",
            { class: "h muted small" },
            el("b", {}, "History"),
            el("span", {}, "Tick two versions to compare them with the same four views."),
        );
        if (!h || h instanceof Promise) {
            histEl.replaceChildren(head, el("div", { class: "h muted" }, "Loading the history..."));
            return;
        }
        if (h.error) {
            histEl.replaceChildren(
                head,
                el(
                    "div",
                    { class: "h" },
                    `The history could not be read: ${h.error}`,
                    control(host, "retry", {
                        zone: "rows",
                        ctx: {
                            run: () => {
                                st.hist.delete(histKey(b));
                                draw();
                            },
                        },
                    }),
                ),
            );
            return;
        }
        const n = h.versions.length;
        fill(
            histEl,
            head,
            h.versions.map((v, i) =>
                el(
                    "div",
                    { class: "h", "data-version": String(i) },
                    control(host, "blcmp", {
                        zone: "rows",
                        tag: "input",
                        ctx: { i },
                        attrs: {
                            type: "checkbox",
                            checked: st.cmp.includes(i),
                            "aria-label": `Compare the ${versionName(i, n)} version`,
                        },
                        children: [],
                    }),
                    el("b", { class: "vname" }, versionName(i, n)),
                    el("span", {}, v.date.slice(0, 10)),
                    el("span", {}, `accepted by ${v.author}`),
                    v.approval?.change ? el("span", {}, `in ${changeName(v.approval.change)}`) : null,
                    el("span", { class: "muted" }, approvalText(v.approval)),
                    v.local
                        ? null
                        : [
                              el("span", { class: "c-failed" }, "Not downloaded"),
                              control(host, "bldlver", { zone: "rows", ctx: { i } }),
                          ],
                ),
            ),
        );
        for (const box of histEl.querySelectorAll("input[type=checkbox]")) {
            box.checked = st.cmp.includes(Number(box.closest("[data-version]").dataset.version));
            // A version not downloaded stays unticked: its control says why.
            box.addEventListener("click", (e) => {
                if (box.getAttribute("aria-disabled") === "true") {
                    e.preventDefault();
                }
            });
        }
    }

    function approvalText(a) {
        if (!a) {
            return "no approval record";
        }
        if (!a.signed) {
            return "not signed (before passkeys)";
        }
        if (!a.verified) {
            return "signature does not verify";
        }
        return a.signer ? `signed by ${a.signer}` : "signed";
    }

    const viewer = createViewer(host, {
        root: "bl-viewer",
        idp: "bl-",
        screen: "baselines",
        names: NAMES,
        imageUrl: (hash) => `/api/baselines/image/${hash}`,
        labels,
        oneImageWhy: (v) => `${VIEW_NAME[v]} needs two versions: tick two in the history below`,
        line: fillLine,
        bar: fillBar,
        below: histEl,
    });

    function drawViewer() {
        const v = $("bl-viewer");
        const b = current();
        if (!b) {
            viewer.stop();
            host.snaps = [];
            host.snap = null;
            v.replaceChildren(
                el(
                    "div",
                    { class: "stage" },
                    el(
                        "div",
                        { class: "emptyv" },
                        el("p", {}, st.loading ? "Loading the baselines..." : "No baseline to show."),
                    ),
                ),
            );
            return;
        }
        loadHistory(b);
        if (!b.local) {
            viewer.stop();
            host.snaps = [];
            host.snap = null;
            v.replaceChildren(
                el(
                    "div",
                    { class: "stage" },
                    el(
                        "div",
                        { class: "emptyv" },
                        el("p", {}, el("b", {}, "Not downloaded")),
                        el(
                            "p",
                            {},
                            control(host, "bldl", { zone: "decision", ctx: { paths: [b.path] }, label: "Download" }),
                        ),
                    ),
                ),
            );
            return;
        }
        const s = viewSnap(b);
        host.snaps = [s];
        host.snap = s.key;
        viewer.draw(s);
        fillHistory(b);
    }

    function draw(settle = true) {
        const shown = rows();
        drawProjects();
        drawHead(shown);
        drawRows(shown);
        drawViewer();
        if (settle) {
            app.settle();
        }
    }

    // ------------------------------------------------------------ moving and choosing

    function move(d) {
        const shown = rows();
        if (shown.length === 0) {
            return false;
        }
        const i = shown.findIndex((b) => b.key === st.cur);
        pick(shown[Math.max(0, Math.min(shown.length - 1, i < 0 ? 0 : i + d))].key);
        st.rowEls.get(st.cur)?.scrollIntoView({ block: "nearest" });
        return true;
    }

    function pick(key) {
        if (key !== st.cur) {
            st.cur = key;
            st.cmp = [];
        }
        draw();
    }

    async function download(paths, commit = null) {
        if (st.busy) {
            return;
        }
        st.busy = true;
        const n = paths.length;
        app.say(`Downloading ${fmt(n)} image${n === 1 ? "" : "s"}...`);
        draw();
        try {
            await api("/api/baselines-download", { ref: st.ref || null, paths, ...(commit && { commit }) });
            app.say(`Downloaded ${fmt(n)} image${n === 1 ? "" : "s"}.`);
        } catch (err) {
            app.say(`The images could not be downloaded: ${err.message}`, "err");
        }
        st.busy = false;
        if (commit) {
            st.hist.delete(histKey(current()));
            draw();
        } else {
            await load();
        }
    }

    Object.assign(host, {
        screen: "baselines",
        level: 0,
        sel: new Set(),
        anchor: null,
        endCard: false,
        opened: new Set(),
        snaps: [],
        snap: null,
        curInSel: () => false,
        draw: () => draw(),
        at,
        stepSnap: (d) => move(d),
        showMenu: (anchor, items) => app.showMenu(anchor, items, host),
        togglePane: (id) => toggle(id === "changes" ? 0 : 1),
        focusFind: (box) => {
            box.focus();
            syncHints();
        },
        // The screen's own actions (actions.js).
        setBaselineRef: (ref) => {
            st.ref = ref;
            st.proj = null;
            st.comp = null;
            st.cur = null;
            st.cmp = [];
            st.hist.clear();
            const c = app.change(ref);
            app.say(
                ref
                    ? `Showing the baselines of ${c ? `${c.label} ${c.title}` : ref}.`
                    : "Showing the default branch's baselines.",
            );
            load();
        },
        pickNode: (project, component) => {
            st.proj = project;
            st.comp = component;
            const shown = rows();
            if (!shown.some((b) => b.key === st.cur)) {
                st.cur = shown[0]?.key ?? null;
                st.cmp = [];
            }
            draw();
        },
        pickBaseline: (key) => pick(key),
        groupLabel: () => GROUPS[st.group],
        groupMenu: (anchor) =>
            app.showMenu(
                anchor,
                Object.entries(GROUPS).map(([k, label]) => ({
                    id: "blgroup",
                    label,
                    checked: st.group === k,
                    ctx: { grouping: k },
                })),
                host,
            ),
        setBaselineGroup: (k) => {
            st.group = k;
            draw();
        },
        toggleCompare: (i) => {
            st.cmp = st.cmp.includes(i) ? st.cmp.filter((x) => x !== i) : [...st.cmp, i].slice(-2);
            draw();
        },
        versionLocal: (i) => historyOf(current())?.versions[i]?.local === true,
        downloadBusy: () => st.busy,
        download: (paths) => download(paths),
        downloadVersion: (i) => {
            const v = historyOf(current())?.versions[i];
            if (v) {
                download([current().path], v.commit);
            }
        },
    });
    host.viewer = viewer;

    $("bl-find").addEventListener("input", () => {
        const shown = rows();
        if (!shown.some((b) => b.key === st.cur)) {
            st.cur = shown[0]?.key ?? null;
            st.cmp = [];
        }
        draw();
    });

    return {
        host,
        viewer,
        draw,
        layout,
        arrow: (d) => move(d),
        // Shows the screen: its panes as the reader left them, its baselines read on the first visit.
        show: () => {
            layout();
            if (!st.list && !st.loading) {
                load();
            } else {
                draw();
            }
            $("bl-list").focus({ preventScroll: true });
        },
        focus: () => {
            (shownNow(IDS)[1] ? $("bl-list") : $("bl-viewer")).focus({ preventScroll: true });
            syncHints();
        },
        clearFind: () => {
            $("bl-find").dispatchEvent(new Event("input"));
        },
    };
}
