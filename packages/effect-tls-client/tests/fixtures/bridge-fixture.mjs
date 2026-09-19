#!/usr/bin/env node

import { spawn } from "node:child_process";
import packageJson from "../../package.json" with { type: "json" };

const mismatch = process.argv.includes("--mismatch");
const exitOnPing = process.argv.includes("--exit");
const delayedStderr = process.argv.includes("--delayed-stderr");
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
        bridgeVersion: mismatch
          ? `${packageJson.version}-mismatch`
          : packageJson.version,
        tlsClientVersion: "fixture",
        goVersion: "fixture-go",
      });
    } else if (kind === 0xf0) {
      if (exitOnPing) {
        const writeStderrChunk = (chunk, next) =>
          process.stderr.write(chunk, () => setTimeout(next, 10));
        const finishExit = () => {
          if (!delayedStderr) {
            process.kill(process.pid, "SIGKILL");
            return;
          }
          const holder = spawn(
            process.execPath,
            ["-e", "setTimeout(() => process.exit(0), 1000)"],
            { stdio: ["ignore", "ignore", process.stderr] },
          );
          holder.unref();
          process.stderr.write(`holder:${holder.pid}\n`, () =>
            process.kill(process.pid, "SIGKILL"),
          );
        };
        writeStderrChunk("a".repeat(2000), () =>
          writeStderrChunk("b".repeat(2000), () =>
            process.stderr.write("c".repeat(2000), finishExit),
          ),
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
