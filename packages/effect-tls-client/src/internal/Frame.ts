/** Protocol-v1 frame encoding shared by the Bridge and its tests. */

export const MAX_FRAME_LENGTH = 16 * 1024 * 1024;
const FIXED_HEADER_LENGTH = 1 + 4 + 4;
const LENGTH_PREFIX = 4;

export const FrameKind = {
  hello: 0x01,
  shutdown: 0x02,
  sessionCreate: 0x10,
  sessionDestroy: 0x11,
  sessionProxy: 0x12,
  cookiesGet: 0x13,
  cookiesSet: 0x14,
  cookiesExport: 0x15,
  cookiesImport: 0x16,
  bandwidthGet: 0x17,
  bandwidthReset: 0x18,
  cookiesScript: 0x19,
  request: 0x20,
  bodyChunk: 0x21,
  bodyEnd: 0x22,
  wsConnect: 0x30,
  wsWrite: 0x31,
  wsClose: 0x32,
  cancel: 0x40,
  ack: 0x41,
  debugPing: 0xf0,
  debugSleep: 0xf1,
  debugStream: 0xf2,
  helloAck: 0x80,
  ok: 0x81,
  error: 0x82,
  headers: 0x90,
  chunk: 0x91,
  end: 0x92,
  wsOpen: 0xa0,
  wsFrame: 0xa1,
  wsClosed: 0xa2,
  bodyAck: 0xc1,
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
const EMPTY_BYTES = new Uint8Array(0);
const decoder = new TextDecoder("utf-8", { fatal: true });

const isUint32 = (value: number): boolean =>
  Number.isInteger(value) && value >= 0 && value <= 0xffffffff;

const metadataBytes = (meta: FrameInput["meta"]): Uint8Array => {
  if (meta === undefined) return EMPTY_BYTES;
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
  const body = input.body ?? EMPTY_BYTES;
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
const decodeFrameView = (encoded: Uint8Array): Frame => {
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
    meta: encoded.subarray(metaStart, metaEnd),
    body: encoded.subarray(metaEnd),
  };
};

/** Decodes exactly one complete frame and owns the returned byte arrays. */
export const decodeFrame = (encoded: Uint8Array): Frame => {
  const frame = decodeFrameView(encoded);
  return {
    ...frame,
    meta: frame.meta.slice(),
    body: frame.body.slice(),
  };
};

/** Incremental decoder for arbitrary stdout chunk boundaries. */
export class FrameDecoder {
  private buffer: Uint8Array = EMPTY_BYTES;

  push(chunk: Uint8Array): ReadonlyArray<Frame> {
    if (chunk.byteLength === 0) return [];
    // Own input chunks before returning subarray-backed frame views.
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
      frames.push(decodeFrameView(merged.subarray(offset, offset + total)));
      offset += total;
    }

    this.buffer =
      offset === merged.byteLength ? EMPTY_BYTES : merged.subarray(offset);
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
