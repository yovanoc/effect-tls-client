import { describe, expect, it } from "@effect/vitest";
import { version } from "../src/index.js";

describe("index", () => {
  it("exports a version string", () => {
    expect(typeof version).toBe("string");
  });
});
