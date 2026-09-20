import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  AGENT_ARENA_CATEGORIES,
  validateAgentArenaTasks,
  type AgentArenaTask,
} from "../src/agent-arena.js";

describe("registered five-arm agent arena", () => {
  it("contains exactly the eight required task categories", async () => {
    const taskPath = path.resolve(
      process.cwd(),
      "../../evals/registered/agent-v0.4-product-tasks.json",
    );
    const parsed = JSON.parse(await readFile(taskPath, "utf8")) as {
      evidenceLevel: string;
      tasks: AgentArenaTask[];
    };
    expect(parsed.evidenceLevel).toBe("REGISTERED_V0_4_PRODUCT_CORPUS");
    expect(parsed.tasks).toHaveLength(8);
    expect(new Set(parsed.tasks.map((task) => task.category))).toEqual(
      new Set(AGENT_ARENA_CATEGORIES),
    );
    expect(() => validateAgentArenaTasks(parsed.tasks)).not.toThrow();
  });
});
