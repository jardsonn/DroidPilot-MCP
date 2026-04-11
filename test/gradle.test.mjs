import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  buildProject,
  detectProject,
  extractApplicationIdFromBuildFile,
} from "../build/engines/gradle.js";

async function createTempProject({
  buildFile,
  wrapperBody,
  apkRelativePath,
}) {
  const projectDir = await mkdtemp(join(tmpdir(), "droidpilot-gradle-test-"));
  await mkdir(join(projectDir, "app"), { recursive: true });
  await writeFile(join(projectDir, "settings.gradle.kts"), "rootProject.name = \"sample\"\ninclude(\":app\")\n");
  await writeFile(join(projectDir, "app", "build.gradle.kts"), buildFile);
  await writeFile(join(projectDir, "gradlew.bat"), wrapperBody);

  if (apkRelativePath) {
    const fullApkPath = join(projectDir, apkRelativePath);
    await mkdir(dirname(fullApkPath), { recursive: true });
    await writeFile(fullApkPath, "");
  }

  return projectDir;
}

test("extractApplicationIdFromBuildFile handles Kotlin and Groovy syntax", () => {
  assert.equal(
    extractApplicationIdFromBuildFile("defaultConfig { applicationId = \"com.example.kotlin\" }"),
    "com.example.kotlin",
  );

  assert.equal(
    extractApplicationIdFromBuildFile("defaultConfig { applicationId 'com.example.groovy' }"),
    "com.example.groovy",
  );
});

test("detectProject accepts Windows gradlew.bat and extracts applicationId", async () => {
  const projectDir = await createTempProject({
    buildFile: "plugins { id(\"com.android.application\") }\nandroid { defaultConfig { applicationId = \"com.example.detect\" } }\n",
    wrapperBody: "@echo off\r\necho gradle stub\r\n",
  });

  try {
    const project = await detectProject(projectDir);
    assert.ok(project);
    assert.equal(project.rootModule, "app");
    assert.equal(project.applicationId, "com.example.detect");
    assert.match(project.gradleWrapper, /gradlew\.bat$/i);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("buildProject returns structured failures when Gradle exits with compiler errors", async () => {
  const projectDir = await createTempProject({
    buildFile: "plugins { id(\"com.android.application\") }\nandroid { defaultConfig { applicationId = \"com.example.fail\" } }\n",
    wrapperBody: "@echo off\r\necho BUILD FAILED\r\necho e: file:///C:/src/Foo.kt:42:13 Unresolved reference: bar\r\nexit /b 1\r\n",
  });

  try {
    const project = await detectProject(projectDir);
    assert.ok(project);

    const result = await buildProject(project, false);
    assert.equal(result.status, "build_failed");
    assert.ok(result.errors.length > 0);
    assert.equal(result.errors[0].file, "C:/src/Foo.kt");
    assert.equal(result.errors[0].line, 42);
    assert.match(result.errors[0].message, /Unresolved reference/);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("buildProject discovers debug APKs after a successful build", async () => {
  const projectDir = await createTempProject({
    buildFile: "plugins { id(\"com.android.application\") }\nandroid { defaultConfig { applicationId = \"com.example.success\" } }\n",
    wrapperBody: "@echo off\r\necho BUILD SUCCESSFUL\r\nexit /b 0\r\n",
    apkRelativePath: join("app", "build", "outputs", "apk", "debug", "app-debug.apk"),
  });

  try {
    const project = await detectProject(projectDir);
    assert.ok(project);

    const result = await buildProject(project, false);
    assert.equal(result.status, "success");
    assert.ok(result.apkPath);
    assert.match(result.apkPath, /app-debug\.apk$/i);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});
