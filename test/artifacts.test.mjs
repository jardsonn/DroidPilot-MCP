import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createSessionArtifactsDir,
  ensureArtifactSubdir,
  nextArtifactPath,
  writeJsonArtifact,
} from "../build/engines/artifacts.js";

test("artifact helpers create session folders and deterministic paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "droidpilot-artifacts-test-"));

  try {
    const sessionDir = await createSessionArtifactsDir("s123", root);
    assert.match(sessionDir, /s123$/);

    const screenshotDir = await ensureArtifactSubdir(sessionDir, "screenshots");
    assert.match(screenshotDir, /screenshots$/);

    const path = await nextArtifactPath(sessionDir, "videos", 2, ".mp4");
    assert.match(path, /videos[\\\/]video-002\.mp4$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("writeJsonArtifact persists structured payloads inside the session tree", async () => {
  const root = await mkdtemp(join(tmpdir(), "droidpilot-artifacts-test-"));

  try {
    const sessionDir = await createSessionArtifactsDir("s999", root);
    const path = await writeJsonArtifact(sessionDir, "snapshots", 1, {
      status: "ok",
      screen: "com.example/.MainActivity",
    });

    assert.match(path, /snapshots[\\\/]snapshot-001\.json$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
