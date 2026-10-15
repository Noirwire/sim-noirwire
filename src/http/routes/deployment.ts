import type { FastifyInstance } from "fastify";
import type { PublicDeployment } from "../../rollup/public-deployment.js";

const CACHE_SECONDS = 300;

/**
 * `GET /v1/deployment`: the program, its public addresses and the URLs a
 * browser trades through. 503 until the service has connected to the rollup.
 */
export const registerDeploymentRoute = (
  app: FastifyInstance,
  deployment: () => PublicDeployment | null,
): void => {
  app.get("/v1/deployment", async (_request, reply) => {
    const described = deployment();
    if (!described) return reply.status(503).send({ error: "the service is still starting" });
    return reply.header("cache-control", `public, max-age=${CACHE_SECONDS}`).send(described);
  });
};
