import { afterAll, beforeEach } from "vitest";

import { closeTestDb, resetDb } from "./db";

// Every integration test starts with no tenant data (the module catalogue stays).
beforeEach(resetDb);
afterAll(closeTestDb);
