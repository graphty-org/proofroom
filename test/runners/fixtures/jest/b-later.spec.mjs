import { test } from "@jest/globals";

import { earlierFailureOnDisk } from "../shared.mjs";

test("later", () => earlierFailureOnDisk());
