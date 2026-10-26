import { jest, test } from "@jest/globals";

import { ids, snapshot } from "../shared.mjs";

jest.retryTimes(Number(process.env.RETRIES ?? 0));

for (const id of ids()) {
    test(id, () => snapshot(id));
}
