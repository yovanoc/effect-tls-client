/** Protocol-v1 frame encoding shared by the Bridge and its tests. */

export const MAX_FRAME_LENGTH = 16 * 1024 * 1024;
const FIXED_HEADER_LENGTH = 1 + 4 + 4;
const LENGTH_PREFIX = 4;

export const FrameKind = {
  hello: 0x01,
  shutdown: 0x02,
  debugPing: 0xf0,
  helloAck: 0x80,
  ok: 0x81,
  error: 0x82,
} as const;

export type FrameKind = (typeof FrameKind)[keyof typeof FrameKind];

const knownKinds = new Set<number>(Object.values(FrameKind));
export const isFrameKind = (value: number): value is FrameKind =>
  knownKinds.has(value);

export interface Frame {
  readonly kind: FrameKind;
  readonly id: number;
  readonly meta: Uint8Array;
  readonly body: Uint8Array;
}

export interface FrameInput {
  readonly kind: FrameKind;
  readonly id: number;
  readonly meta?: unknown;
  readonly body?: Uint8Array;
}

export class FrameCodecError extends Error {
  readonly _tag = "FrameCodecError";

  constructor(message: string) {
    super(message);
    this.name = "FrameCodecError";
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

const isUint32 = (value: number): boolean =>
  Number.isInteger(value) && value >= 0 && value <= 0xffffffff;

const metadataBytes = (meta: FrameInput["meta"]): Uint8Array => {
  if (meta === undefined) return new Uint8Array(0);
  if (meta instanceof Uint8Array) return meta;
  if (typeof meta === "string") return encoder.encode(meta);
  try {
    const encoded = JSON.stringify(meta);
    if (encoded === undefined)
      throw new FrameCodecError("metadata is not JSON-serializable");
    return encoder.encode(encoded);
  } catch (cause) {
    if (cause instanceof FrameCodecError) throw cause;
    throw new FrameCodecError(`metadata encoding failed: ${String(cause)}`);
  }
};

/** Encodes [u32 length][u8 kind][u32 id][u32 metadataLength][meta][body]. */
export const encodeFrame = (input: FrameInput): Uint8Array => {
  if (!isFrameKind(input.kind))
    throw new FrameCodecError(`invalid frame kind: ${input.kind}`);
  if (!isUint32(input.id))
    throw new FrameCodecError(`invalid frame id: ${input.id}`);

  const meta = metadataBytes(input.meta);
  const body = input.body ?? new Uint8Array(0);
  const length = FIXED_HEADER_LENGTH + meta.byteLength + body.byteLength;
  if (length > MAX_FRAME_LENGTH) {
    throw new FrameCodecError(
      `frame length ${length} exceeds max ${MAX_FRAME_LENGTH}`,
    );
  }

  const encoded = new Uint8Array(LENGTH_PREFIX + length);
  const view = new DataView(encoded.buffer);
  view.setUint32(0, length, false);
  view.setUint8(4, input.kind);
  view.setUint32(5, input.id, false);
  view.setUint32(9, meta.byteLength, false);
  encoded.set(meta, 13);
  encoded.set(body, 13 + meta.byteLength);
  return encoded;
};

/** Decodes exactly one complete frame. Extra or truncated bytes are rejected. */
export const decodeFrame = (encoded: Uint8Array): Frame => {
  if (encoded.byteLength < LENGTH_PREFIX) {
    throw new FrameCodecError("frame is missing its length prefix");
  }

  const view = new DataView(
    encoded.buffer,
    encoded.byteOffset,
    encoded.byteLength,
  );
  const length = view.getUint32(0, false);
  if (length > MAX_FRAME_LENGTH) {
    throw new FrameCodecError(
      `frame length ${length} exceeds max ${MAX_FRAME_LENGTH}`,
    );
  }
  if (length < FIXED_HEADER_LENGTH) {
    throw new FrameCodecError(
      `frame length ${length} is smaller than ${FIXED_HEADER_LENGTH}`,
    );
  }
  if (encoded.byteLength !== LENGTH_PREFIX + length) {
    throw new FrameCodecError(
      `frame has ${encoded.byteLength - LENGTH_PREFIX} bytes after its prefix; expected ${length}`,
    );
  }

  const kind = view.getUint8(4);
  if (!isFrameKind(kind))
    throw new FrameCodecError(`invalid frame kind: ${kind}`);

  const metadataLength = view.getUint32(9, false);
  if (metadataLength > length - FIXED_HEADER_LENGTH) {
    throw new FrameCodecError(
      `metadata length ${metadataLength} exceeds frame length ${length}`,
    );
  }

  const metaStart = LENGTH_PREFIX + FIXED_HEADER_LENGTH;
  const metaEnd = metaStart + metadataLength;
  return {
    kind,
    id: view.getUint32(5, false),
    meta: encoded.slice(metaStart, metaEnd),
    body: encoded.slice(metaEnd),
  };
};

/** Incremental decoder for arbitrary stdout chunk boundaries. */
export class FrameDecoder {
  private buffer = new Uint8Array(0);

  push(chunk: Uint8Array): ReadonlyArray<Frame> {
    if (chunk.byteLength === 0) return [];
    const merged = new Uint8Array(this.buffer.byteLength + chunk.byteLength);
    merged.set(this.buffer);
    merged.set(chunk, this.buffer.byteLength);

    const frames: Array<Frame> = [];
    let offset = 0;
    while (merged.byteLength - offset >= LENGTH_PREFIX) {
      const length = new DataView(
        merged.buffer,
        merged.byteOffset + offset,
        LENGTH_PREFIX,
      ).getUint32(0, false);
      if (length > MAX_FRAME_LENGTH) {
        throw new FrameCodecError(
          `frame length ${length} exceeds max ${MAX_FRAME_LENGTH}`,
        );
      }
      if (length < FIXED_HEADER_LENGTH) {
        throw new FrameCodecError(
          `frame length ${length} is smaller than ${FIXED_HEADER_LENGTH}`,
        );
      }
      const total = LENGTH_PREFIX + length;
      if (merged.byteLength - offset < total) break;
      frames.push(decodeFrame(merged.slice(offset, offset + total)));
      offset += total;
    }

    this.buffer = merged.slice(offset);
    return frames;
  }

  finish(): void {
    if (this.buffer.byteLength !== 0) {
      throw new FrameCodecError("stream ended with an incomplete frame");
    }
  }
}

export const decodeFrames = (encoded: Uint8Array): ReadonlyArray<Frame> => {
  const decoder = new FrameDecoder();
  const frames = decoder.push(encoded);
  decoder.finish();
  return frames;
};

export const decodeUtf8 = (bytes: Uint8Array): string => {
  try {
    return decoder.decode(bytes);
  } catch (cause) {
    throw new FrameCodecError(`metadata is not valid UTF-8: ${String(cause)}`);
  }
};
