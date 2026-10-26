import { test } from "vitest";

import { ids, snapshot } from "../shared.mjs";

for (const id of ids()) {
    test(id, () => snapshot(id));
}
