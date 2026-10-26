import { test } from "vitest";

import { earlierFailureOnDisk } from "../shared.mjs";

test("later", () => earlierFailureOnDisk());
