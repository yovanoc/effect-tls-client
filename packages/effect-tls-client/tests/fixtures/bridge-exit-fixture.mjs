#!/usr/bin/env node

process.argv.push("--exit");
await import("./bridge-fixture.mjs");
