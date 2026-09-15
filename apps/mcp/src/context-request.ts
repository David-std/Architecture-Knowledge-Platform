import { ContextPacketMode, ContextRequest } from "@akp/contracts";
import { z } from "zod";

/**
 * Agents read this over a token-constrained channel, so the MCP surface defaults to
 * the compact projection and a tighter budget than the REST default. Only the
 * defaults differ: the shape is still derived from the shared contract, so a field
 * added there reaches this tool automatically instead of silently diverging.
 *
 * It lives in its own module so the schema can be asserted without importing the
 * server, which requires API credentials at load time.
 */
export const McpContextRequest = ContextRequest.extend({
  maxTokens: z.number().int().min(256).max(32_000).default(6_000),
  packetMode: ContextPacketMode.default("COMPACT_AGENT_PACKET"),
});

export type McpContextRequest = z.infer<typeof McpContextRequest>;
