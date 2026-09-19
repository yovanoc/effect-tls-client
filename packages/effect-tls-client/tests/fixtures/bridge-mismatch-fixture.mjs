#!/usr/bin/env node

process.argv.push("--mismatch");
await import("./bridge-fixture.mjs");
