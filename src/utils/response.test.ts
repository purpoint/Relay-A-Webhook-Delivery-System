import { describe, it, expect } from "vitest";
import { success, failure } from "./response.js";

describe("response envelope", () => {
  it("wraps data with success=true and a null error", () => {
    const res = success({ id: "abc" });

    expect(res.success).toBe(true);
    expect(res.data).toEqual({ id: "abc" });
    expect(res.error).toBeNull();
  });

  it("wraps errors with success=false and null data", () => {
    const res = failure("NOT_FOUND", "Webhook not found");

    expect(res.success).toBe(false);
    expect(res.data).toBeNull();
    expect(res.error).toEqual({ code: "NOT_FOUND", message: "Webhook not found" });
  });

  it("omits details entirely when none are given", () => {
    // Distinct from `details: undefined` — the key should not be serialised at
    // all, so clients never see a dangling null field.
    const res = failure("CONFLICT", "Already exists");

    expect(Object.keys(res.error ?? {})).not.toContain("details");
  });

  it("includes details when supplied", () => {
    const res = failure("VALIDATION_ERROR", "Bad request", [{ path: "url" }]);

    expect(res.error?.details).toEqual([{ path: "url" }]);
  });

  it("stamps an ISO-8601 timestamp", () => {
    const res = success(null);

    expect(res.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
    expect(Number.isNaN(Date.parse(res.timestamp))).toBe(false);
  });
});
