export const platformLayer = async () =>
  typeof Bun === "undefined"
    ? (await import("@effect/platform-node")).NodeServices.layer
    : (await import("@effect/platform-bun")).BunServices.layer;
