import type { Deployment } from "./settings.js";
import { deployedToken } from "./tokens.js";

/** The USDC mint on Solana mainnet. */
export const MAINNET_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

/**
 * Refuses a deployment description that is not a mainnet one: another
 * network's, one that names a faucet, or one whose money is not the real
 * USDC. Throws one error naming every problem.
 */
export const requireMainnetDeployment = (deployment: Deployment): void => {
  const problems: string[] = [];
  if (deployment.network !== "mainnet") {
    problems.push(
      `the description is for the network "${deployment.network}", not mainnet. ` +
        "Point DEPLOYMENT_PATH at the description the mainnet launch wrote.",
    );
  }
  if (deployment.faucet) {
    problems.push(
      "the description names a faucet, and mainnet has none. " +
        "Point DEPLOYMENT_PATH at the description the mainnet launch wrote.",
    );
  }
  const collateral = deployedToken(deployment, "nUSD");
  if (collateral?.symbol !== "USDC" || collateral.mint !== MAINNET_USDC_MINT) {
    problems.push(
      "the description's quote token is not the real USDC mint. " +
        "Point DEPLOYMENT_PATH at the description the mainnet launch wrote.",
    );
  }
  if (problems.length > 0) {
    throw new Error(
      `NETWORK=mainnet cannot use this deployment description:\n${problems.map((line) => `- ${line}`).join("\n")}`,
    );
  }
};
