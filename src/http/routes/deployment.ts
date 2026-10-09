import type { FastifyInstance } from "fastify";
import type { PublicDeployment } from "../../rollup/public-deployment.js";

const CACHE_SECONDS = 300;

/** `GET /v1/deployment`: the program, its public addresses and the URLs a browser trades through. */
export const registerDeploymentRoute = (
  app: FastifyInstance,
  deployment: PublicDeployment,
): void => {
  app.get("/v1/deployment", async (_request, reply) =>
    reply.header("cache-control", `public, max-age=${CACHE_SECONDS}`).send(deployment),
  );
};
