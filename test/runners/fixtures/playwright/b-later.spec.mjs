import { test } from "@playwright/test";

import { earlierFailureOnDisk } from "../shared.mjs";

test("later", () => earlierFailureOnDisk());
