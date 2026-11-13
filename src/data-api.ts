import { loadConfig } from "./config/config.js";
import { run } from "./run.js";

/** The read-only market data API on its own: it holds no key, and its health never depends on the maker. */
void run(() => loadConfig(process.env, "data"));
