import { describe, expect, it, vi } from "vitest";
import type { NotionIntegrationShape } from "../notion/Services/NotionIntegration.ts";
import { Effect } from "effect";
import { makeAgentGatewayNotionTools } from "./notionTools.ts";
import type { ToolContext } from "./toolRuntime.ts";
import { plainNotionText } from "@synara/shared/notion";

const sourceId = "11111111-1111-4111-8111-111111111111";
const unrelatedId = "22222222-2222-4222-8222-222222222222";
const recordId = "33333333-3333-4333-8333-333333333333";
const workspace = "workspace:bot";
const page = (dataSourceId: string) => ({
  object: "page",
  id: recordId,
  parent: { type: "data_source_id", data_source_id: dataSourceId },
  properties: {
    Work: { id: "title", type: "title", title: plainNotionText("Review sprint") },
    Status: { id: "status", type: "status", status: { id: "todo", name: "To do" } },
    Secret: { id: "private", type: "rich_text", rich_text: plainNotionText("Do not expose unmapped data") },
  },
});
const mapping = {
  id: "tasks",
  name: "Tasks",
  enabled: true,
  connectionId: workspace,
  dataSourceId: sourceId,
  agentAccess: "read",
  fields: { title: { id: "title", type: "title" }, status: { id: "status", type: "status" } },
};
function makeFixture(input: {
  readonly enabled?: boolean;
  readonly connected?: boolean;
  readonly foreign?: boolean;
} = {}) {
  const state = () => ({
    configured: true,
    syncing: false,
    syncError: null,
    lastSyncedAt: null,
    changes: [],
    mappings: [{ ...mapping, agentAccess: input.enabled === false ? "none" : "read" }],
    connections: [{ id: workspace, status: input.connected === false ? "needs-auth" : "connected" }],
  });
  const read = vi.fn(async (options: { readonly kind: string }) => {
    if (options.kind === "query") return { data: { results: [page(input.foreign ? unrelatedId : sourceId)], has_more: false } };
    if (options.kind === "page") return { data: page(input.foreign ? unrelatedId : sourceId) };
    if (options.kind === "children") return {
      data: { results: [{ type: "paragraph", paragraph: { rich_text: plainNotionText("Untrusted document body") } }], has_more: false },
    };
    throw new Error("Unexpected Notion operation.");
  });
  const integration = { runtime: { read }, state } as unknown as NotionIntegrationShape;
  const tools = makeAgentGatewayNotionTools(integration);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const tool = tools.find(item => item.definition.name === name);
    if (!tool) throw new Error("Missing tool: " + name);
    const result = await Effect.runPromise(tool.handler(args, {} as ToolContext));
    const first = result.content[0];
    const text = first?.type === "text" ? first.text : "";
    return { text, isError: result.isError === true, body: result.isError ? null : JSON.parse(text) as Record<string, unknown> };
  };
  return { read, call, tools };
}

describe("scoped Notion agent tools", () => {
  it("never offers a token, unrestricted workspace search, or write tools", async () => {
    const { tools, call } = makeFixture();
    expect(tools.map(value => value.definition.name)).toEqual([
      "synara_notion_list_sources",
      "synara_notion_query_records",
      "synara_notion_read_record",
    ]);
    const sources = await call("synara_notion_list_sources");
    expect(sources.body?.sources).toEqual([{ mappingId: "tasks", name: "Tasks", agentAccess: "read" }]);
    expect(sources.text).not.toContain("accessToken");
  });

  it("does not call Notion for disabled or disconnected mappings", async () => {
    for (const condition of [{ enabled: false }, { connected: false }]) {
      const { call, read } = makeFixture(condition);
      const response = await call("synara_notion_query_records", { mappingId: "tasks" });
      expect(response.isError).toBe(true);
      expect(read).not.toHaveBeenCalled();
    }
  });

  it("returns bounded mapped metadata without exposing arbitrary properties", async () => {
    const { call, read } = makeFixture();
    const response = await call("synara_notion_query_records", { mappingId: "tasks", titleContains: "sprint" });
    expect(response.isError).toBe(false);
    expect(response.body?.externalContent).toBe(true);
    expect(response.text).toContain("Review sprint");
    expect(response.text).not.toContain("Do not expose unmapped data");
    expect(read).toHaveBeenCalledWith(expect.objectContaining({
      kind: "query",
      id: sourceId,
      filter: { property: "title", title: { contains: "sprint" } },
    }));
  });

  it("rejects a response containing a record outside the mapped data source", async () => {
    const { call } = makeFixture({ foreign: true });
    const response = await call("synara_notion_query_records", { mappingId: "tasks" });
    expect(response.isError).toBe(true);
    expect(response.text).not.toContain("Review sprint");
  });

  it("checks record ancestry before requesting any blocks", async () => {
    const { call, read } = makeFixture({ foreign: true });
    const response = await call("synara_notion_read_record", { mappingId: "tasks", pageId: recordId });
    expect(response.isError).toBe(true);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("returns a bounded, clearly untrusted block preview for a permitted record", async () => {
    const { call, read } = makeFixture();
    const response = await call("synara_notion_read_record", { mappingId: "tasks", pageId: recordId });
    expect(response.isError).toBe(false);
    expect(response.body?.externalContent).toBe(true);
    expect(response.text).toContain("Untrusted document body");
    expect(read).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenNthCalledWith(2, expect.objectContaining({ kind: "children", pageSize: 25 }));
  });
});
