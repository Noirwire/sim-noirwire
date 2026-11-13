import { loadConfig } from "./config/config.js";
import { run } from "./run.js";

/** The combined service, or the role SIM_ROLE names. The separate entry points are `maker.ts`, `gate.ts` and `data-api.ts`. */
void run(() => loadConfig());
