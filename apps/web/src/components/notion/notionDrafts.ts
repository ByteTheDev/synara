import type { NotionObject } from "@synara/contracts";
import { notionCanonical, notionComparableValue } from "@synara/shared/notion";

/** Drafts stay local. Only changed, supported fields are sent to the existing runtime. */
export function notionBlockDraftPatch(type: string, base: NotionObject, values: NotionObject) {
  if (!["paragraph", "heading_1", "heading_2", "heading_3", "bulleted_list_item", "numbered_list_item", "to_do", "toggle", "quote", "callout", "code"].includes(type)) {
    throw new Error("This block type is read-only in Synara.");
  }
  if (!Array.isArray(base.rich_text) || !Array.isArray(values.rich_text) || type === "to_do" && (typeof base.checked !== "boolean" || typeof values.checked !== "boolean")) {
    throw new Error("This block is incomplete. Reload it before editing.");
  }
  const keys = type === "to_do" ? ["rich_text", "checked"] : ["rich_text"];
  const changed = keys.filter((key) => notionCanonical(notionComparableValue(base[key], key)) !== notionCanonical(notionComparableValue(values[key], key)));
  return {
    base: Object.fromEntries(changed.map((key) => [key, structuredClone(base[key])])),
    changes: Object.fromEntries(changed.map((key) => [key, structuredClone(values[key])])),
  };
}
