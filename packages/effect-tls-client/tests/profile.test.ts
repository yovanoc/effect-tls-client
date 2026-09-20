import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";
import { CustomProfile, Profile } from "../src/index.js";

describe("generated profile schemas", () => {
  it("keeps known profiles open to future upstream identifiers", () => {
    const typedProfiles: readonly [Profile.Known, Profile] = [
      "chrome_146",
      "future_profile",
    ];
    expect(typedProfiles).toEqual(["chrome_146", "future_profile"]);
    expect(Schema.decodeUnknownSync(Profile)("chrome_146")).toBe("chrome_146");
    expect(Schema.decodeUnknownSync(Profile)("future_profile")).toBe(
      "future_profile",
    );
    expect(() => Schema.decodeUnknownSync(Profile)(123)).toThrow();
  });

  it("restricts custom profile enum names", () => {
    const decode = Schema.decodeUnknownSync(CustomProfile);
    expect(
      decode({
        ja3String: "771,4865,0,,",
        h2Settings: { HEADER_TABLE_SIZE: 65536 },
        keyShareCurves: ["X25519"],
      }).h2Settings,
    ).toEqual({ HEADER_TABLE_SIZE: 65536 });
    expect(() => decode({ h2Settings: { UNKNOWN_SETTING: 1 } })).toThrow();
    expect(() => decode({ certCompressionAlgos: ["unknown"] })).toThrow();
  });
});
