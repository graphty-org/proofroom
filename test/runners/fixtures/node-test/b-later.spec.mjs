import { test } from "node:test";

import { earlierFailureOnDisk } from "../shared.mjs";

test("later", () => earlierFailureOnDisk());
