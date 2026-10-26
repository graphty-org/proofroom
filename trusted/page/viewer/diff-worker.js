/*
 * The changed pixels of a pair of images, worked out off the page's thread, so a diff never holds
 * up a key press. A module worker: it gets both images as RGBA pixels at one size (their buffers
 * transferred, not copied), and sends back the mask, the mask grown by GROW pixels, the boxes
 * around each grown region and both pixel arrays, transferred again. It needs no canvas, so it
 * runs wherever module workers do.
 */

import pixelmatch from "/pixelmatch.mjs";
import { grow, regions } from "/spot.js";

self.onmessage = ({ data: { id, w, h, a, b, threshold, includeAA } }) => {
    try {
        const [pa, pb] = [new Uint8ClampedArray(a), new Uint8ClampedArray(b)];
        const mask = new Uint8ClampedArray(w * h * 4);
        pixelmatch(pa, pb, mask, w, h, { threshold, includeAA, diffMask: true });
        const grown = grow(mask, w, h);
        const boxes = regions(grown, w, h);
        self.postMessage({ id, mask, grown, boxes, a: pa, b: pb }, [mask.buffer, grown.buffer, pa.buffer, pb.buffer]);
    } catch (err) {
        self.postMessage({ id, error: err.message });
    }
};
