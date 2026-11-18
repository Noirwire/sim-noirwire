import { loadConfig } from "./config/config.js";
import { run } from "./run.js";

/** The house maker on its own: it holds the maker seeds and never the gate key. Its health answers on PORT. */
void run(() => loadConfig(process.env, "maker"));
