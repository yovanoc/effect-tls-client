#!/usr/bin/env node

process.argv.push("--exit", "--delayed-stderr");
await import("./bridge-fixture.mjs");
