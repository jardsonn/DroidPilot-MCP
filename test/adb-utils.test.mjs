import test from "node:test";
import assert from "node:assert/strict";

import {
  extractComposeTestTag,
  extractCrashSummaries,
  formatLogcatEpoch,
  parseLogcatEntries,
} from "../build/engines/adb.js";

test("extractComposeTestTag normalizes standard ids and raw Compose tags", () => {
  assert.equal(extractComposeTestTag("com.example:id/login_button"), "login_button");
  assert.equal(extractComposeTestTag("profile_tab"), "profile_tab");
  assert.equal(extractComposeTestTag(undefined), undefined);
});

test("formatLogcatEpoch produces logcat-compatible epoch strings", () => {
  assert.equal(formatLogcatEpoch(1775888000123), "1775888000.123");
});

test("parseLogcatEntries parses epoch output into structured entries", () => {
  const entries = parseLogcatEntries(`
--------- beginning of main
         1775888000.123  16700  16700 E AndroidRuntime: FATAL EXCEPTION: main
         1775888000.124  16700  16700 E AndroidRuntime: Process: com.example.app, PID: 16700
         1775888000.125  16700  16700 E AndroidRuntime: java.lang.IllegalStateException: Boom
  `);

  assert.equal(entries.length, 3);
  assert.equal(entries[0].epochMs, 1775888000123);
  assert.equal(entries[0].pid, 16700);
  assert.equal(entries[0].tag, "AndroidRuntime");
  assert.match(entries[2].message, /IllegalStateException/);
});

test("extractCrashSummaries groups crash windows for the target package", () => {
  const entries = parseLogcatEntries(`
         1775888000.123  16700  16700 E AndroidRuntime: FATAL EXCEPTION: main
         1775888000.124  16700  16700 E AndroidRuntime: Process: com.example.app, PID: 16700
         1775888000.125  16700  16700 E AndroidRuntime: java.lang.IllegalStateException: Boom
         1775888000.200  19000  19000 E AndroidRuntime: Process: com.other.app, PID: 19000
  `);

  const crashes = extractCrashSummaries(entries, {
    packageName: "com.example.app",
    pid: 16700,
  });

  assert.equal(crashes.length, 1);
  assert.match(crashes[0], /com\.example\.app/);
  assert.doesNotMatch(crashes[0], /com\.other\.app/);
});
