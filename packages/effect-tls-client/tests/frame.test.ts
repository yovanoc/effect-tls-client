import { describe, expect, it } from "@effect/vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  decodeFrame,
  FrameCodecError,
  FrameDecoder,
  FrameKind,
  encodeFrame,
  MAX_FRAME_LENGTH,
} from "../src/internal/Frame.js";
import {
  EmptyMeta,
  AckMeta,
  CancelMeta,
  ChunkMeta,
  EndMeta,
  ErrorMeta,
  HelloAckMeta,
  HelloMeta,
  decodeEmptyMeta,
  decodeMeta,
  encodeMeta,
} from "../src/internal/Protocol.js";

const required = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error("missing test fixture value");
  return value;
};

const hex = (value: string): Uint8Array => {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
};

const golden = (
  name: "go-to-ts.hex" | "ts-to-go.hex",
): ReadonlyArray<readonly [string, Uint8Array]> =>
  readFileSync(
    fileURLToPath(
      new URL(`../../../bridge/testdata/protocol/${name}`, import.meta.url),
    ),
    "utf8",
  )
    .split("\n")
    .filter((line) => line.trim() !== "" && !line.startsWith("#"))
    .map((line) => {
      const [label, value] = line.trim().split(/\s+/);
      return [required(label), hex(required(value))] as const;
    });

const expectBytes = (actual: Uint8Array, expected: Uint8Array): void => {
  expect(Array.from(actual)).toEqual(Array.from(expected));
};

describe("protocol v1 frame codec", () => {
  it("decodes and re-encodes Go golden frames byte-identically", () => {
    for (const [name, bytes] of golden("go-to-ts.hex")) {
      const frame = decodeFrame(bytes);
      expectBytes(encodeFrame(frame), bytes);
      expect(name).toBeTruthy();
    }

    const helloAckBytes = required(golden("go-to-ts.hex")[0]);
    const helloAck = decodeMeta(
      HelloAckMeta,
      decodeFrame(helloAckBytes[1]).meta,
    );
    expect(helloAck.bridgeVersion).toBe("0.0.0");
    const error = decodeMeta(
      ErrorMeta,
      decodeFrame(required(golden("go-to-ts.hex")[2])[1]).meta,
    );
    expect(error.kind).toBe("Protocol");
    const chunk = decodeFrame(required(golden("go-to-ts.hex")[4])[1]);
    expect(decodeMeta(ChunkMeta, chunk.meta)).toEqual({});
    expectBytes(chunk.body, new Uint8Array([1, 2, 3]));
    expect(
      decodeMeta(
        EndMeta,
        decodeFrame(required(golden("go-to-ts.hex")[5])[1]).meta,
      ),
    ).toEqual({
      bytesRead: 3,
      bytesWritten: 0,
    });
  });

  it("encodes TS golden frames byte-identically", () => {
    const expected = golden("ts-to-go.hex");
    const actual = [
      encodeFrame({
        kind: FrameKind.hello,
        id: 0,
        meta: encodeMeta(HelloMeta, {
          protocolVersion: 1,
          clientVersion: "0.0.0",
          window: 1024 * 1024,
          chunkSize: 64 * 1024,
        }),
      }),
      encodeFrame({
        kind: FrameKind.shutdown,
        id: 0,
        meta: encodeMeta(EmptyMeta, {}),
      }),
      encodeFrame({
        kind: FrameKind.debugPing,
        id: 7,
        meta: encodeMeta(EmptyMeta, {}),
      }),
      encodeFrame({
        kind: FrameKind.cancel,
        id: 8,
        meta: encodeMeta(CancelMeta, {}),
      }),
      encodeFrame({
        kind: FrameKind.ack,
        id: 8,
        meta: encodeMeta(AckMeta, { bytes: 3 }),
      }),
    ];
    expect(actual).toHaveLength(expected.length);
    for (let index = 0; index < actual.length; index += 1) {
      expectBytes(required(actual[index]), required(expected[index])[1]);
    }
    expect(
      decodeMeta(HelloMeta, decodeFrame(required(actual[0])).meta)
        .clientVersion,
    ).toBe("0.0.0");
  });

  it("handles arbitrary stream chunk boundaries and edge bodies", () => {
    const bytes = required(golden("go-to-ts.hex")[6])[1];
    const decoder = new FrameDecoder();
    const frames = [];
    for (let index = 0; index < bytes.byteLength; index += 1) {
      frames.push(...decoder.push(bytes.slice(index, index + 1)));
    }
    decoder.finish();
    expect(frames).toHaveLength(1);
    const frame = required(frames[0]);
    expect(frame.id).toBe(0xffffffff);
    expectBytes(frame.body, new Uint8Array([0, 0xff]));
    expect(decodeEmptyMeta(frame.meta)).toEqual({});
  });

  it("owns frames returned from mutable input chunks", () => {
    const encoded = encodeFrame({
      kind: FrameKind.chunk,
      id: 1,
      body: new Uint8Array([1, 2]),
    });
    const decoder = new FrameDecoder();
    const [frame] = decoder.push(encoded);
    encoded.fill(0);
    expect(frame?.body).toEqual(new Uint8Array([1, 2]));
  });

  it("owns buffered frame prefixes", () => {
    const encoded = encodeFrame({
      kind: FrameKind.chunk,
      id: 1,
      body: new Uint8Array([1, 2]),
    });
    const decoder = new FrameDecoder();
    const prefix = encoded.slice(0, 5);
    const suffix = encoded.slice(5);
    expect(decoder.push(prefix)).toHaveLength(0);
    prefix.fill(0);
    const [frame] = decoder.push(suffix);
    expect(frame?.body).toEqual(new Uint8Array([1, 2]));
  });

  it("owns direct frame decode output", () => {
    const encoded = encodeFrame({
      kind: FrameKind.chunk,
      id: 1,
      body: new Uint8Array([1, 2]),
    });
    const frame = decodeFrame(encoded);
    encoded[13] = 9;
    expectBytes(frame.body, new Uint8Array([1, 2]));
  });

  it("rejects oversized, truncated, and malformed frames", () => {
    const oversized = new Uint8Array(4);
    new DataView(oversized.buffer).setUint32(0, MAX_FRAME_LENGTH + 1, false);
    expect(() => decodeFrame(oversized)).toThrow(FrameCodecError);
    expect(() => decodeFrame(new Uint8Array([0, 0, 0]))).toThrow(
      FrameCodecError,
    );

    const malformed = new Uint8Array(13);
    const malformedView = new DataView(malformed.buffer);
    malformedView.setUint32(0, 9, false);
    malformedView.setUint32(9, 1_000, false);
    expect(() => decodeFrame(malformed)).toThrow(FrameCodecError);

    const unknown = encodeFrame({
      kind: FrameKind.ok,
      id: 1,
      meta: encodeMeta(EmptyMeta, {}),
    });
    unknown[4] = 0x7f;
    expect(() => decodeFrame(unknown)).toThrow(FrameCodecError);

    const decoder = new FrameDecoder();
    decoder.push(required(golden("go-to-ts.hex")[0])[1].slice(0, 5));
    expect(() => decoder.finish()).toThrow(FrameCodecError);
  });
});
