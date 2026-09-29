import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateAgentAbTasks, type AgentAbTask } from "../src/agent-ab.js";

describe("registered public-product Agent A/B task set", () => {
  it("covers every required task category with registered-corpus evidence", async () => {
    const taskPath = path.resolve(
      process.cwd(),
      "../../evals/registered/agent-ab-public-product-tasks.json",
    );
    const parsed = JSON.parse(await readFile(taskPath, "utf8")) as {
      evidenceLevel: string;
      sourceCorpus: string;
      tasks: AgentAbTask[];
    };

    expect(parsed.evidenceLevel).toBe("REGISTERED_PUBLIC_PRODUCT_CORPUS");
    expect(parsed.sourceCorpus).toBe(
      "architecture-knowledge-platform-public-product-docs",
    );
    expect(() => validateAgentAbTasks(parsed.tasks)).not.toThrow();
    expect(parsed.tasks).toHaveLength(6);
    expect(
      parsed.tasks.find((task) => task.category === "project-code"),
    ).toMatchObject({
      intent: "PROJECT_CODE",
      projectId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
      ),
    });
  });
});
