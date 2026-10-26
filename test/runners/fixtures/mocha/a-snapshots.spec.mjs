/* global it -- mocha's */
import { ids, snapshot } from "../shared.mjs";

for (const id of ids()) {
    it(id, () => snapshot(id));
}
