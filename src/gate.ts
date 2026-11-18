import { loadConfig } from "./config/config.js";
import { run } from "./run.js";

/** The gate on its own: it holds the gate key and the seat record, and never the maker seeds. */
void run(() => loadConfig(process.env, "gate"));
