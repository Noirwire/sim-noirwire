/** The first line of an error's message, or of whatever else was thrown. */
export const firstLine = (error: unknown): string =>
  error instanceof Error ? error.message.split("\n")[0] : String(error ?? "");
