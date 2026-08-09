import { createServer } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer } from "./server.js";

const port = Number(process.env.AKP_MCP_HTTP_PORT ?? 8081);
const expectedToken = process.env.AKP_API_TOKEN;
if (!expectedToken) throw new Error("AKP_API_TOKEN is required for HTTP MCP.");

const http = createServer(async (request, response) => {
  if (request.url !== "/mcp" || request.method !== "POST") {
    response.writeHead(405, { "content-type": "application/json" });
    response.end(JSON.stringify({ code: "METHOD_NOT_ALLOWED" }));
    return;
  }
  if (request.headers.authorization !== `Bearer ${expectedToken}`) {
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify({ code: "AUTHENTICATION_REQUIRED" }));
    return;
  }
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport();
  await server.connect(transport as never);
  await transport.handleRequest(request, response);
  response.on("close", () => {
    void transport.close();
    void server.close();
  });
});

http.listen(port, "127.0.0.1", () => {
  console.log(JSON.stringify({ service: "akp-mcp-http", status: "UP", port }));
});
