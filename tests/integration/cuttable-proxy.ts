import net from "node:net";

export interface Route {
  listen: number;
  target: number;
}

type Mode = "pass" | "refuse" | "hang";

/**
 * A TCP proxy on this machine that a test can cut. `refuse` resets every
 * connection, old and new, as an unreachable network does. `hang` accepts
 * connections and never answers, as a silent one does: the failure a request
 * with no timeout waits on forever. `restore` passes traffic again.
 */
export class CuttableProxy {
  private mode: Mode = "pass";
  private readonly servers: net.Server[] = [];
  private readonly sockets = new Set<net.Socket>();

  constructor(private readonly routes: Route[]) {}

  async start(): Promise<void> {
    for (const route of this.routes) {
      const server = net.createServer((client) => this.accept(client, route.target));
      this.servers.push(server);
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(route.listen, "127.0.0.1", () => resolve());
      });
    }
  }

  private track(socket: net.Socket): void {
    this.sockets.add(socket);
    socket.on("close", () => this.sockets.delete(socket));
    socket.on("error", () => socket.destroy());
  }

  private accept(client: net.Socket, target: number): void {
    this.track(client);
    if (this.mode === "refuse") {
      client.destroy();
      return;
    }
    if (this.mode === "hang") return;
    const upstream = net.connect(target, "127.0.0.1");
    this.track(upstream);
    client.pipe(upstream).pipe(client);
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
  }

  cut(mode: "refuse" | "hang"): void {
    this.mode = mode;
    for (const socket of this.sockets) {
      if (mode === "refuse") socket.destroy();
      else socket.pause();
    }
  }

  restore(): void {
    this.mode = "pass";
    for (const socket of this.sockets) socket.destroy();
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await Promise.all(
      this.servers.map((server) => new Promise((resolve) => server.close(resolve))),
    );
  }
}
