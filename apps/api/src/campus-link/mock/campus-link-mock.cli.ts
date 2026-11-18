/**
 * Runs the Campus contract mock (#2752 item 1) over HTTP, for building Campus's client before the
 * real routes exist:
 *
 *   pnpm --filter @badabhai/api build
 *   pnpm --filter @badabhai/api campus:mock -- --port=4100 --token=<any test token>
 *
 * Campus then points `SERVICE_OUTBOUND_BADABHAI_BASE_URL` at `http://127.0.0.1:4100` and sends the
 * same token in `X-Service-Token`. Local use only: it binds to 127.0.0.1, holds state in memory
 * and touches no database.
 */
import { createServer } from "node:http";
import { parseArgs } from "node:util";
import { createCampusLinkMock } from "./campus-link-mock";

const MAX_BODY_BYTES = 1_000_000;

function main(): void {
  const { values } = parseArgs({
    options: {
      port: { type: "string", default: "4100" },
      token: { type: "string" },
    },
  });
  const port = Number(values.port);
  if (!Number.isInteger(port) || port <= 0 || !values.token) {
    console.error("usage: campus:mock -- --port=<port> --token=<token>");
    process.exitCode = 2;
    return;
  }

  const handle = createCampusLinkMock({ token: values.token });
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) req.destroy();
      else chunks.push(chunk);
    });
    req.on("end", () => {
      const headers = Object.fromEntries(
        Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]),
      );
      const result = handle({
        method: req.method ?? "GET",
        url: req.url ?? "/",
        headers,
        body: chunks.length > 0 ? Buffer.concat(chunks).toString("utf8") : undefined,
      });
      res.writeHead(result.status, { "content-type": "application/json" });
      res.end(JSON.stringify(result.body));
    });
  });

  server.listen(port, "127.0.0.1", () => {
    console.log(`campus contract mock on http://127.0.0.1:${port}/internal/campus/v1`);
  });
}

main();
