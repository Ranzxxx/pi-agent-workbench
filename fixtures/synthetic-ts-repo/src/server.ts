import { getHealth } from "./health.js";

export interface ServerHandle {
  port: number;
  close(): Promise<void>;
}

export async function startServer(port = 4317): Promise<ServerHandle> {
  const server = Bun.serve({
    port,
    fetch(request) {
      if (new URL(request.url).pathname === "/health") {
        return Response.json(getHealth());
      }
      return new Response("Not found", { status: 404 });
    },
  });

  return { port: server.port, close: () => server.stop() };
}
