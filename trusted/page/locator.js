/*
 * The viewer's locator (design 5.3): at 2x and above, a 120 px miniature of the whole image at the
 * stage's lower right, a rectangle for the part the frames show and a dot for each changed area.
 * Clicking it moves every frame's view there; scrolling a frame moves the rectangle.
 */

import { control } from "./actions.js";
import { el } from "./ui.js";

const clicked = new WeakMap(); // where on the locator the reader pressed, as fractions
const framesOf = new WeakMap();

// The picture a frame scrolls over: its left, top, width and height in the frame's content.
const sheetOf = (frame) => {
    const sheet = frame.querySelector(".sheet");
    return sheet ? [sheet.offsetLeft, sheet.offsetTop, sheet.offsetWidth, sheet.offsetHeight] : null;
};

/**
 * A locator for the frames on the stage.
 * @param {any} app the page
 * @param {{ src: string, size: [number, number], boxes: number[][], frames: HTMLElement[] }} what
 *     the whole image's address, its size in image pixels, the changed areas ([x, y, width,
 *     height], image pixels) and the frames it moves
 * @returns {HTMLElement} the locator; it follows the frames once it is on the page
 */
export function makeLocator(app, { src, size: [w, h], boxes, frames }) {
    const rect = el("div", { class: "lr" });
    const node = control(app, "locator", {
        zone: "toolbar",
        tag: "div",
        attrs: { class: "locator", role: "button", "aria-label": "Locator: the whole image, click to move the view" },
        children: [
            el("img", { src, alt: "" }),
            boxes.map(([x, y, bw, bh]) => {
                // Through the element's style: the page's content security policy refuses style attributes.
                const dot = el("span", { class: "ld" });
                dot.style.left = `${(100 * (x + bw / 2)) / w}%`;
                dot.style.top = `${(100 * (y + bh / 2)) / h}%`;
                return dot;
            }),
            rect,
        ],
    });
    framesOf.set(node, frames);
    node.addEventListener("pointerdown", (e) => {
        const r = node.getBoundingClientRect();
        clicked.set(node, [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height]);
    });
    const follow = () => {
        const f = frames[0];
        const at = f && sheetOf(f);
        if (!at) {
            return;
        }
        const [sx, sy, sw, sh] = at;
        const part = (scroll, start, size, view) => {
            const from = Math.max(0, Math.min(1, (scroll - start) / size));
            return [from, Math.min(1 - from, view / size)];
        };
        const [left, width] = part(f.scrollLeft, sx, sw, f.clientWidth);
        const [top, height] = part(f.scrollTop, sy, sh, f.clientHeight);
        Object.assign(rect.style, {
            left: `${100 * left}%`,
            top: `${100 * top}%`,
            width: `${100 * width}%`,
            height: `${100 * height}%`,
        });
    };
    for (const f of frames) {
        f.addEventListener("scroll", follow);
    }
    requestAnimationFrame(follow);
    return node;
}

/**
 * Moves every frame so the point last pressed on the locator is in the middle of its view.
 * @param {HTMLElement} node the locator
 */
export function moveToPressed(node) {
    const [fx, fy] = clicked.get(node) ?? [0.5, 0.5];
    for (const f of framesOf.get(node) ?? []) {
        const at = sheetOf(f);
        if (at) {
            const [sx, sy, sw, sh] = at;
            f.scrollLeft = sx + fx * sw - f.clientWidth / 2;
            f.scrollTop = sy + fy * sh - f.clientHeight / 2;
        }
    }
}
