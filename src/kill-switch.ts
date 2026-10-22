import { KILL_SWITCH_USAGE, killSwitchRequest, requestMode } from "./bots/maker-control.js";

const main = async (): Promise<void> => {
  const request = killSwitchRequest(process.argv.slice(2));
  if (!request.ok) {
    console.error(request.message);
    process.exit(request.message === KILL_SWITCH_USAGE ? 2 : 1);
  }
  const dataDir = process.env.DATA_DIR ?? "./data";
  await requestMode(dataDir, request.mode, Date.now());
  console.log(
    `Written to ${dataDir}. Within a second, ${request.meaning}. ` +
      "The service's log says when it has followed it, and the choice survives a restart.",
  );
};

main().catch((error) => {
  console.error(
    `The kill switch did not write its request, so nothing changed: ${error instanceof Error ? error.message : error}`,
  );
  process.exit(1);
});
