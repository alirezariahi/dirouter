/**
 * MCP tool-call log (card 20.1): records from the gateway's `mcp-calls` queue become rows of
 * `mcp_tool_calls` (idempotent by id), and rows older than the retention are removed daily.
 */
import { McpCallRecord } from '@dirouter/contracts';
import type { Prisma, PrismaClient } from '@dirouter/db';

export async function writeMcpCall(db: PrismaClient, data: unknown): Promise<void> {
  const call = McpCallRecord.parse(data);
  await db.mcpToolCall.createMany({
    data: [
      {
        id: call.id,
        occurredAt: new Date(call.occurredAt),
        organizationId: call.organizationId,
        projectId: call.projectId,
        apiKeyId: call.virtualKeyId,
        serverId: call.serverId,
        tool: call.tool,
        arguments: call.arguments as Prisma.InputJsonObject,
        status: call.status,
        errorMessage: call.errorMessage ?? null,
        latencyMs: call.latencyMs,
        gatewayInstance: call.gatewayInstance,
      },
    ],
    skipDuplicates: true,
  });
}

export async function dropOldMcpCalls(db: PrismaClient, days: number, now = Date.now()) {
  const { count } = await db.mcpToolCall.deleteMany({
    where: { occurredAt: { lt: new Date(now - days * 86_400_000) } },
  });
  return { deleted: count };
}
