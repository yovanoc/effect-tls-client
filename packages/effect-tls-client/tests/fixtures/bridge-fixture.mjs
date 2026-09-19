#!/usr/bin/env node

const mismatch = process.argv.includes("--mismatch");
const exitOnPing = process.argv.includes("--exit");
let buffer = Buffer.alloc(0);
const writeFrame = (kind, id, metadata = {}) => {
  const meta = Buffer.from(JSON.stringify(metadata));
  const rest = Buffer.alloc(9 + meta.length);
  rest.writeUInt8(kind, 0);
  rest.writeUInt32BE(id, 1);
  rest.writeUInt32BE(meta.length, 5);
  meta.copy(rest, 9);
  const frame = Buffer.alloc(4 + rest.length);
  frame.writeUInt32BE(rest.length, 0);
  rest.copy(frame, 4);
  process.stdout.write(frame);
};

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length >= 4) {
    const length = buffer.readUInt32BE(0);
    if (buffer.length < length + 4) return;
    const frame = buffer.subarray(4, length + 4);
    buffer = buffer.subarray(length + 4);
    const kind = frame.readUInt8(0);
    const id = frame.readUInt32BE(1);
    if (kind === 0x01) {
      writeFrame(0x80, 0, {
        protocolVersion: 1,
        bridgeVersion: mismatch ? "9.9.9" : "0.0.0",
        tlsClientVersion: "fixture",
        goVersion: "fixture-go",
      });
    } else if (kind === 0xf0) {
      if (exitOnPing) {
        process.stderr.write("x".repeat(5000), () =>
          process.kill(process.pid, "SIGKILL"),
        );
      } else {
        writeFrame(0x81, id, {});
      }
    } else if (kind === 0x02) {
      writeFrame(0x81, 0, {});
      process.exit(0);
    }
  }
});
