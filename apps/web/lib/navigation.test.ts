import { describe, expect, it } from "vitest";
import { areaForPath, navigation, parentForPath } from "./navigation";

describe("operator navigation", () => {
  it("keeps all primary destinations reachable exactly once", () => {
    const routes = navigation.flatMap((area) =>
      area.links.map((link) => link.href),
    );
    expect(new Set(routes).size).toBe(routes.length);
    expect(routes).toContain("/ingest");
    expect(routes).toContain("/admin/audit");
  });

  it("resolves section and list context for detail routes", () => {
    expect(areaForPath("/reviews/review-id")).toBe("work");
    expect(parentForPath("/reviews/review-id")).toEqual({
      href: "/reviews",
      label: "Revisiones",
    });
    expect(areaForPath("/sources/source-id")).toBe("knowledge");
    expect(areaForPath("/jobs/job-id")).toBe("processes");
    expect(parentForPath("/work/object-id")).toEqual({
      href: "/",
      label: "Inicio",
    });
    expect(parentForPath("/knowledge/document-id")).toEqual({
      href: "/search",
      label: "Buscar",
    });
  });

  it("keeps login outside the product areas", () => {
    expect(areaForPath("/login")).toBeNull();
    expect(parentForPath("/login")).toBeNull();
  });
});
