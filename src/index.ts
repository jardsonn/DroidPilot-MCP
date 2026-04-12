#!/usr/bin/env node

/**
 * DroidPilot MCP Server
 *
 * A robust MCP server that lets AI coding agents build, deploy,
 * inspect, and interact with Android apps on emulators/devices.
 */

import { join } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod/v4";

import { AdbError } from "./engines/adb.js";
import * as adb from "./engines/adb.js";
import {
  createSessionArtifactsDir,
  listArtifacts,
  nextArtifactPath,
  writeJsonArtifact,
} from "./engines/artifacts.js";
import { GradleError } from "./engines/gradle.js";
import * as gradle from "./engines/gradle.js";
import { compareSnapshots, evaluateSnapshotStability } from "./engines/snapshot-diff.js";
import {
  describeElement,
  describeQuery,
  type ElementQuery,
  findMatchingElements,
} from "./engines/selectors.js";
import {
  closeSession,
  createSession,
  getSession,
  requireSession,
  setSessionSnapshot,
  updateSession,
} from "./engines/session.js";

const server = new McpServer({
  name: "droidpilot",
  version: "0.5.0",
});

const elementQueryShape = {
  ref: z.string().optional().describe("Exact snapshot ref, for example '@e1'"),
  resourceId: z.string().optional().describe("Exact Android resource id"),
  resourceIdContains: z.string().optional().describe("Substring match against resource id"),
  testTag: z.string().optional().describe("Exact Compose testTag value when testTagsAsResourceId is enabled"),
  testTagContains: z.string().optional().describe("Substring match against Compose testTag"),
  label: z.string().optional().describe("Best-effort label derived from the element's own or nearby text"),
  labelContains: z.string().optional().describe("Substring match against the best-effort label"),
  text: z.string().optional().describe("Exact visible text"),
  textContains: z.string().optional().describe("Substring match against visible text"),
  contentDesc: z.string().optional().describe("Exact content description"),
  contentDescContains: z.string().optional().describe("Substring match against content description"),
  hint: z.string().optional().describe("Exact hint text"),
  hintContains: z.string().optional().describe("Substring match against hint text"),
  parentTextContains: z.string().optional().describe("Match text exposed by the nearest textual ancestor"),
  childTextContains: z.string().optional().describe("Match text exposed by descendants of the element"),
  siblingTextContains: z.string().optional().describe("Match text exposed by sibling nodes in the same container"),
  contextTextContains: z.string().optional().describe("Match any nearby context text gathered from parent, sibling, or child nodes"),
  nearText: z.string().optional().describe("Prefer the candidate nearest to this anchor text"),
  nearTextContains: z.string().optional().describe("Prefer the candidate nearest to text containing this value"),
  type: z.string().optional().describe("Exact view type, for example 'Button'"),
  clickable: z.boolean().optional(),
  focusable: z.boolean().optional(),
  scrollable: z.boolean().optional(),
  editable: z.boolean().optional(),
  enabled: z.boolean().optional(),
  checked: z.boolean().optional(),
  selected: z.boolean().optional(),
};

function jsonResponse(payload: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

function serializeError(error: unknown) {
  if (error instanceof AdbError || error instanceof GradleError) {
    return {
      status: "error",
      code: error.code,
      error: error.message,
      details: error.details,
    };
  }

  if (error instanceof Error) {
    return {
      status: "error",
      error: error.message,
    };
  }

  return {
    status: "error",
    error: "Unknown server failure",
  };
}

function toolHandler<TArgs>(handler: (args: TArgs) => Promise<unknown>) {
  return async (args: TArgs) => {
    try {
      return jsonResponse(await handler(args));
    } catch (error) {
      return jsonResponse(serializeError(error));
    }
  };
}

function normalizePackageName(): string | null {
  const session = getSession();
  return session?.packageName ?? session?.project?.applicationId ?? null;
}

function normalizeElementQuery(args: Record<string, unknown>): ElementQuery {
  return {
    ref: typeof args.ref === "string" ? args.ref : undefined,
    resourceId: typeof args.resourceId === "string" ? args.resourceId : undefined,
    resourceIdContains: typeof args.resourceIdContains === "string" ? args.resourceIdContains : undefined,
    testTag: typeof args.testTag === "string" ? args.testTag : undefined,
    testTagContains: typeof args.testTagContains === "string" ? args.testTagContains : undefined,
    label: typeof args.label === "string" ? args.label : undefined,
    labelContains: typeof args.labelContains === "string" ? args.labelContains : undefined,
    text: typeof args.text === "string" ? args.text : undefined,
    textContains: typeof args.textContains === "string" ? args.textContains : undefined,
    contentDesc: typeof args.contentDesc === "string" ? args.contentDesc : undefined,
    contentDescContains: typeof args.contentDescContains === "string" ? args.contentDescContains : undefined,
    hint: typeof args.hint === "string" ? args.hint : undefined,
    hintContains: typeof args.hintContains === "string" ? args.hintContains : undefined,
    parentTextContains: typeof args.parentTextContains === "string" ? args.parentTextContains : undefined,
    childTextContains: typeof args.childTextContains === "string" ? args.childTextContains : undefined,
    siblingTextContains: typeof args.siblingTextContains === "string" ? args.siblingTextContains : undefined,
    contextTextContains: typeof args.contextTextContains === "string" ? args.contextTextContains : undefined,
    nearText: typeof args.nearText === "string" ? args.nearText : undefined,
    nearTextContains: typeof args.nearTextContains === "string" ? args.nearTextContains : undefined,
    type: typeof args.type === "string" ? args.type : undefined,
    clickable: typeof args.clickable === "boolean" ? args.clickable : undefined,
    focusable: typeof args.focusable === "boolean" ? args.focusable : undefined,
    scrollable: typeof args.scrollable === "boolean" ? args.scrollable : undefined,
    editable: typeof args.editable === "boolean" ? args.editable : undefined,
    enabled: typeof args.enabled === "boolean" ? args.enabled : undefined,
    checked: typeof args.checked === "boolean" ? args.checked : undefined,
    selected: typeof args.selected === "boolean" ? args.selected : undefined,
  };
}

function isEmptyQuery(query: ElementQuery): boolean {
  return Object.values(query).every((value) => value === undefined);
}

function hasPrimarySelectorFields(query: ElementQuery): boolean {
  return Object.entries(query).some(
    ([key, value]) => !["nearText", "nearTextContains"].includes(key) && value !== undefined,
  );
}

function hasSelectorFieldsBeyondRef(query: ElementQuery): boolean {
  return Object.entries(query).some(([key, value]) => key !== "ref" && value !== undefined);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function nextSessionArtifactSequence(kind: "snapshot" | "screenshot" | "diff" | "video") {
  const session = requireSession();
  const nextValue = session.artifactCounters[kind] + 1;
  updateSession({
    artifactCounters: {
      ...session.artifactCounters,
      [kind]: nextValue,
    },
  });
  return nextValue;
}

async function writeSnapshotArtifact(snapshot: adb.Snapshot, interactiveOnly: boolean): Promise<string | null> {
  const session = requireSession();
  if (!session.artifactsDir) {
    return null;
  }

  const sequence = await nextSessionArtifactSequence("snapshot");
  const path = await writeJsonArtifact(session.artifactsDir, "snapshots", sequence, {
    interactiveOnly,
    capturedAt: new Date(snapshot.timestamp).toISOString(),
    snapshot,
  });
  updateSession({ lastSnapshotArtifactPath: path });
  return path;
}

async function writeDiffArtifact(diff: unknown): Promise<string | null> {
  const session = requireSession();
  if (!session.artifactsDir) {
    return null;
  }

  const sequence = await nextSessionArtifactSequence("diff");
  const path = await writeJsonArtifact(session.artifactsDir, "diffs", sequence, diff);
  updateSession({ lastDiffArtifactPath: path });
  return path;
}

async function nextSessionFileArtifactPath(kind: "screenshots" | "videos", extension: string): Promise<string | null> {
  const session = requireSession();
  if (!session.artifactsDir) {
    return null;
  }

  const counterKind = kind === "screenshots" ? "screenshot" : "video";
  const sequence = await nextSessionArtifactSequence(counterKind);
  return nextArtifactPath(session.artifactsDir, kind, sequence, extension);
}

async function waitForApp(packageName: string, serial?: string, timeoutMs: number = 10_000): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await adb.isAppRunning(packageName, serial)) {
      return true;
    }
    await sleep(500);
  }
  return false;
}

async function captureSessionSnapshot(interactiveOnly: boolean = true) {
  const session = requireSession();
  const snapshot = await adb.captureSnapshot(interactiveOnly, session.device?.serial);
  setSessionSnapshot(snapshot);
  await writeSnapshotArtifact(snapshot, interactiveOnly);
  return snapshot;
}

async function getSnapshotForAssertion(refresh: boolean, interactiveOnly: boolean) {
  const session = requireSession();
  if (!refresh && session.lastSnapshot) {
    return session.lastSnapshot;
  }
  return captureSessionSnapshot(interactiveOnly);
}

async function resolveActionTarget(
  args: Record<string, unknown>,
  options?: {
    refreshDefault?: boolean;
    interactiveOnlyDefault?: boolean;
  },
) {
  const session = requireSession();
  const query = normalizeElementQuery(args);
  if (isEmptyQuery(query)) {
    return {
      ok: false as const,
      error: "Provide at least one selector field such as ref, text, resourceId, or contentDesc.",
      query,
      queryDescription: describeQuery(query),
    };
  }
  if (!hasPrimarySelectorFields(query)) {
    return {
      ok: false as const,
      error: "nearText is a disambiguator, not a full selector by itself. Combine it with a target selector such as clickable=true, textContains, resourceId, or type.",
      query,
      queryDescription: describeQuery(query),
    };
  }

  const refresh = typeof args.refresh === "boolean" ? args.refresh : (options?.refreshDefault ?? true);
  const interactiveOnly =
    typeof args.interactiveOnly === "boolean" ? args.interactiveOnly : (options?.interactiveOnlyDefault ?? false);

  const useStoredSnapshot = query.ref !== undefined && !hasSelectorFieldsBeyondRef(query);
  const snapshot = useStoredSnapshot
    ? session.lastSnapshot
    : await getSnapshotForAssertion(refresh, interactiveOnly);

  if (!snapshot) {
    return {
      ok: false as const,
      error: "No snapshot available for ref-based action. Call 'snapshot' first or use a semantic selector.",
      query,
      queryDescription: describeQuery(query),
    };
  }

  const matches = findMatchingElements(snapshot, query);
  if (matches.length === 0) {
    return {
      ok: false as const,
      error: `No visible element matched the selector: ${describeQuery(query)}.`,
      query,
      queryDescription: describeQuery(query),
      screen: snapshot.screen,
      package: snapshot.packageName,
      matchCount: 0,
    };
  }

  return {
    ok: true as const,
    snapshot,
    query,
    queryDescription: describeQuery(query),
    matchCount: matches.length,
    element: matches[0],
  };
}

async function waitForElementMatch(
  query: ElementQuery,
  options: {
    timeoutMs: number;
    intervalMs: number;
    interactiveOnly: boolean;
  },
) {
  const startedAt = Date.now();
  let lastSnapshot = await captureSessionSnapshot(options.interactiveOnly);
  let matches = findMatchingElements(lastSnapshot, query);

  while (matches.length === 0 && Date.now() - startedAt < options.timeoutMs) {
    await sleep(options.intervalMs);
    lastSnapshot = await captureSessionSnapshot(options.interactiveOnly);
    matches = findMatchingElements(lastSnapshot, query);
  }

  return {
    snapshot: lastSnapshot,
    matches,
    waitedMs: Date.now() - startedAt,
  };
}

async function waitForIdleState(options: {
  timeoutMs: number;
  idleMs: number;
  pollIntervalMs: number;
  interactiveOnly: boolean;
  ignoreTextualChanges: boolean;
  maxChangedElements: number;
  maxAddedElements: number;
  maxRemovedElements: number;
}) {
  const startedAt = Date.now();
  let previousSnapshot = await captureSessionSnapshot(options.interactiveOnly);
  let lastSnapshot = previousSnapshot;
  let lastMeaningfulChangeAt = Date.now();

  while (Date.now() - startedAt < options.timeoutMs) {
    if (Date.now() - lastMeaningfulChangeAt >= options.idleMs) {
      return {
        status: "ok" as const,
        snapshot: lastSnapshot,
        waitedMs: Date.now() - startedAt,
        stableForMs: Date.now() - lastMeaningfulChangeAt,
      };
    }

    await sleep(options.pollIntervalMs);
    const snapshot = await captureSessionSnapshot(options.interactiveOnly);
    const stability = evaluateSnapshotStability(previousSnapshot, snapshot, {
      ignoreTextualChanges: options.ignoreTextualChanges,
      maxChangedElements: options.maxChangedElements,
      maxAddedElements: options.maxAddedElements,
      maxRemovedElements: options.maxRemovedElements,
    });

    lastSnapshot = snapshot;
    if (!stability.stable) {
      lastMeaningfulChangeAt = Date.now();
    }
    previousSnapshot = snapshot;
  }

  return {
    status: "timeout" as const,
    snapshot: lastSnapshot,
    waitedMs: Date.now() - startedAt,
    stableForMs: Date.now() - lastMeaningfulChangeAt,
  };
}

async function scrollUntilMatch(
  query: ElementQuery,
  options: {
    direction: "up" | "down" | "left" | "right";
    maxScrolls: number;
    pauseMs: number;
    interactiveOnly: boolean;
  },
) {
  let snapshot = await captureSessionSnapshot(options.interactiveOnly);
  let matches = findMatchingElements(snapshot, query);
  let scrollCount = 0;

  while (matches.length === 0 && scrollCount < options.maxScrolls) {
    const session = requireSession();
    await adb.scroll(options.direction, session.device?.serial);
    scrollCount += 1;
    await sleep(options.pauseMs);
    snapshot = await captureSessionSnapshot(options.interactiveOnly);
    matches = findMatchingElements(snapshot, query);
  }

  return {
    snapshot,
    matches,
    scrollCount,
  };
}

server.tool(
  "doctor",
  "Validate the local DroidPilot environment: adb resolution, connected devices, selected device, project detection, and an optional UI snapshot probe.",
  {
    projectDir: z.string().optional().describe("Optional Android project root to validate."),
    deviceSerial: z.string().optional().describe("Optional explicit device serial."),
    preferEmulator: z.boolean().optional().describe("Prefer an emulator when auto-selecting. Default: true"),
    checkSnapshot: z.boolean().optional().describe("Attempt a lightweight UI snapshot on the chosen device. Default: false"),
  },
  toolHandler(async ({ projectDir, deviceSerial, preferEmulator, checkSnapshot }) => {
    const report: Record<string, unknown> = {
      status: "ok",
      nodeVersion: process.version,
      javaHome: process.env.JAVA_HOME ?? null,
      androidHome: process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? null,
    };

    try {
      report.adbPath = await adb.getAdbPath();
    } catch (error) {
      return {
        ...report,
        ...serializeError(error),
      };
    }

    const devices = await adb.listDevices();
    report.devices = devices;
    report.readyDevices = devices.filter((device) => device.status === "device").length;

    try {
      const selectedDevice = await adb.getActiveDevice(deviceSerial, preferEmulator ?? true);
      report.selectedDevice = selectedDevice;
    } catch (error) {
      report.selectedDeviceError = serializeError(error);
    }

    if (projectDir) {
      const project = await gradle.detectProject(projectDir);
      report.project = project
        ? {
            detected: true,
            ...project,
          }
        : {
            detected: false,
          };
    }

    if (checkSnapshot) {
      const selectedDevice = report.selectedDevice as adb.Device | undefined;
      if (selectedDevice?.serial) {
        try {
          const snapshot = await adb.captureSnapshot(true, selectedDevice.serial);
          report.snapshotProbe = {
            ok: true,
            screen: snapshot.screen,
            package: snapshot.packageName,
            elementCount: snapshot.elements.length,
          };
        } catch (error) {
          report.snapshotProbe = {
            ok: false,
            error: serializeError(error),
          };
        }
      } else {
        report.snapshotProbe = {
          ok: false,
          error: "No ready device available for snapshot probe.",
        };
      }
    }

    if (!report.selectedDevice) {
      report.status = "warning";
    }

    return report;
  }),
);

server.tool(
  "open",
  "Open a DroidPilot session. Detects the Android project, chooses a ready emulator by default, and prepares for build/test.",
  {
    projectDir: z.string().describe("Path to the Android project root (where settings.gradle lives)"),
    deviceSerial: z.string().optional().describe("Specific device/emulator serial to use, e.g. 'emulator-5554'"),
    preferEmulator: z.boolean().optional().describe("Prefer an emulator over a physical device. Default: true"),
    artifactsDir: z.string().optional().describe("Optional directory for session artifacts such as snapshots, diffs, screenshots, and videos."),
  },
  toolHandler(async ({ projectDir, deviceSerial, preferEmulator, artifactsDir }) => {
    const project = await gradle.detectProject(projectDir);
    if (!project) {
      return {
        status: "error",
        code: "PROJECT_NOT_FOUND",
        error: `No Android project found at ${projectDir}. Expected settings.gradle(.kts) and a Gradle wrapper.`,
      };
    }

    const devices = await adb.listDevices();
    const device = await adb.getActiveDevice(deviceSerial, preferEmulator ?? true);
    if (!device) {
      return {
        status: "error",
        code: "DEVICE_NOT_FOUND",
        error: "No ready Android device or emulator found.",
        availableDevices: devices,
      };
    }

    const session = createSession();
    const sessionArtifactsDir = await createSessionArtifactsDir(session.id, artifactsDir);
    const lastKnownPid = project.applicationId
      ? await adb.getAppPid(project.applicationId, device.serial)
      : null;
    updateSession({
      project,
      device,
      packageName: project.applicationId ?? null,
      artifactsDir: sessionArtifactsDir,
      lastKnownPid,
    });

    return {
      status: "ok",
      session: session.id,
      adbPath: await adb.getAdbPath(),
      artifactsDir: sessionArtifactsDir,
      project: {
        dir: project.projectDir,
        module: project.rootModule,
        applicationId: project.applicationId,
        buildVariant: project.buildVariant,
      },
      device,
      baselines: {
        sessionLogEpochMs: session.logBaselineEpochMs,
        launchLogEpochMs: session.launchBaselineEpochMs,
      },
      availableDevices: devices,
    };
  }),
);

server.tool(
  "close",
  "Close the current DroidPilot session and stop the app when possible.",
  {},
  toolHandler(async () => {
    const session = getSession();
    if (session?.recording) {
      await adb.stopScreenRecording(session.recording.localPath, {
        serial: session.recording.serial ?? undefined,
        remotePath: session.recording.remotePath,
      });
    }
    if (session?.packageName) {
      await adb.stopApp(session.packageName, session.device?.serial);
    }

    const { durationS } = closeSession();
    return { status: "closed", durationS };
  }),
);

server.tool(
  "build",
  "Build the Android project. Runs Gradle assembleDebug and returns structured diagnostics.",
  {
    clean: z.boolean().optional().describe("Whether to run a clean build. Default: false"),
  },
  toolHandler(async ({ clean }) => {
    const session = requireSession();
    if (!session.project) {
      return { status: "error", error: "No project is attached to the active session." };
    }

    return gradle.buildProject(session.project, clean ?? false);
  }),
);

server.tool(
  "run",
  "Build, install, and launch the app on the selected Android device.",
  {
    clean: z.boolean().optional().describe("Whether to run a clean build first. Default: false"),
  },
  toolHandler(async ({ clean }) => {
    const session = requireSession();
    if (!session.project) {
      return { status: "error", error: "No project is attached to the active session." };
    }

    const serial = session.device?.serial;
    const buildResult = await gradle.buildProject(session.project, clean ?? false);
    if (buildResult.status !== "success") {
      return {
        status: "build_failed",
        buildDurationMs: buildResult.durationMs,
        errors: buildResult.errors,
        warningsCount: buildResult.warningsCount,
        summary: buildResult.summary,
        outputTail: buildResult.outputTail,
      };
    }

    if (!buildResult.apkPath) {
      return {
        status: "build_failed",
        error: "Build succeeded, but DroidPilot could not locate a debug APK.",
        summary: buildResult.summary,
        outputTail: buildResult.outputTail,
      };
    }

    const installResult = await adb.installApk(buildResult.apkPath, serial);
    if (!installResult.success) {
      return {
        status: "install_failed",
        apkPath: buildResult.apkPath,
        error: installResult.error,
      };
    }

    const packageName = buildResult.packageName ?? session.packageName ?? session.project.applicationId;
    if (!packageName) {
      return {
        status: "error",
        error: "Build finished, but DroidPilot could not determine the app package name.",
        apkPath: buildResult.apkPath,
      };
    }

    const launchBaselineEpochMs = Date.now();
    const launchResult = await adb.launchApp(packageName, buildResult.launchActivity, serial);
    if (!launchResult.success) {
      return {
        status: "launch_failed",
        package: packageName,
        launchActivity: buildResult.launchActivity,
        error: launchResult.error,
      };
    }

    const running = await waitForApp(packageName, serial, 12_000);
    const lastKnownPid = await adb.getAppPid(packageName, serial);
    updateSession({
      packageName,
      lastKnownPid,
      launchBaselineEpochMs,
      project: {
        ...session.project,
        applicationId: packageName,
      },
    });

    return {
      status: running ? "running" : "launched",
      package: packageName,
      activity: launchResult.component ?? buildResult.launchActivity,
      apkPath: buildResult.apkPath,
      buildDurationMs: buildResult.durationMs,
      incremental: buildResult.incremental,
      warningsCount: buildResult.warningsCount,
      summary: buildResult.summary,
      outputTail: buildResult.outputTail,
      baselines: {
        sessionLogEpochMs: session.logBaselineEpochMs,
        launchLogEpochMs: launchBaselineEpochMs,
      },
    };
  }),
);

server.tool(
  "open_deeplink",
  "Open a deeplink/URI on the current device, optionally targeting the current app package, then optionally wait for the UI to settle.",
  {
    uri: z.string().describe("Full deeplink URI such as myapp://profile/123 or https://example.com/deeplink"),
    packageName: z.string().optional().describe("Optional package to target. Defaults to the current session package when known."),
    waitForIdle: z.boolean().optional().describe("Wait for the UI to settle after opening the deeplink. Default: true"),
    idleMs: z.number().optional().describe("How long the UI should remain unchanged before considered idle. Default: 900"),
    timeoutMs: z.number().optional().describe("Maximum wait time when waitForIdle is enabled. Default: 10000"),
    interactiveOnly: z.boolean().optional().describe("Only inspect interactive elements during wait_for_idle. Default: false"),
    ignoreTextualChanges: z.boolean().optional().describe("Ignore text-only churn such as timers or subtle labels while waiting for idle. Default: true"),
    maxChangedElements: z.number().optional().describe("How many non-textual element changes are tolerated while still considering the UI idle. Default: 1"),
    maxAddedElements: z.number().optional().describe("How many added elements are tolerated while still considering the UI idle. Default: 0"),
    maxRemovedElements: z.number().optional().describe("How many removed elements are tolerated while still considering the UI idle. Default: 0"),
  },
  toolHandler(async ({
    uri,
    packageName,
    waitForIdle,
    idleMs,
    timeoutMs,
    interactiveOnly,
    ignoreTextualChanges,
    maxChangedElements,
    maxAddedElements,
    maxRemovedElements,
  }) => {
    const session = requireSession();
    const effectivePackage = packageName ?? session.packageName ?? session.project?.applicationId ?? null;
    const result = await adb.openDeeplink(uri, {
      packageName: effectivePackage,
      serial: session.device?.serial,
    });

    if (!result.success) {
      return {
        status: "failed",
        uri,
        package: effectivePackage,
        error: result.error,
      };
    }

    let idleResult: Awaited<ReturnType<typeof waitForIdleState>> | null = null;
    if (waitForIdle ?? true) {
      idleResult = await waitForIdleState({
        timeoutMs: timeoutMs ?? 10_000,
        idleMs: idleMs ?? 900,
        pollIntervalMs: 350,
        interactiveOnly: interactiveOnly ?? false,
        ignoreTextualChanges: ignoreTextualChanges ?? true,
        maxChangedElements: maxChangedElements ?? 1,
        maxAddedElements: maxAddedElements ?? 0,
        maxRemovedElements: maxRemovedElements ?? 0,
      });
    }

    return {
      status: "ok",
      uri,
      package: effectivePackage,
      activity: result.component ?? null,
      idle: idleResult
        ? {
            status: idleResult.status,
            waitedMs: idleResult.waitedMs,
            stableForMs: idleResult.stableForMs,
            screen: idleResult.snapshot.screen,
            package: idleResult.snapshot.packageName,
          }
        : null,
    };
  }),
);

server.tool(
  "snapshot",
  "Capture the current UI state. Returns the accessibility tree with stable refs like @e1 and @e2.",
  {
    interactiveOnly: z.boolean().optional().describe("Only include interactive elements. Default: true"),
  },
  toolHandler(async ({ interactiveOnly }) => {
    const snapshot = await captureSessionSnapshot(interactiveOnly ?? true);
    const session = requireSession();

    return {
      status: "ok",
      screen: snapshot.screen,
      package: snapshot.packageName,
      elementCount: snapshot.elements.length,
      previousSnapshotAvailable: session.previousSnapshot !== null,
      artifactPath: session.lastSnapshotArtifactPath,
      elements: snapshot.elements.map((element) => ({
        ref: element.ref,
        type: element.type,
        label: element.label,
        text: element.text,
        hint: element.hint,
        contentDesc: element.contentDesc,
        resourceId: element.resourceId,
        testTag: element.testTag,
        parentRef: element.parentRef,
        depth: element.depth,
        parentText: element.parentText,
        childText: element.childText,
        siblingText: element.siblingText,
        contextText: element.contextText,
        clickable: element.clickable,
        focusable: element.focusable,
        scrollable: element.scrollable,
        editable: element.editable,
        enabled: element.enabled,
        checked: element.checked,
        selected: element.selected,
      })),
    };
  }),
);

server.tool(
  "snapshot_diff",
  "Compare two consecutive UI snapshots to understand what changed before and after a navigation or action.",
  {
    refresh: z.boolean().optional().describe("Capture a fresh snapshot before diffing. Default: true"),
    interactiveOnly: z.boolean().optional().describe("Only include interactive elements when refreshing. Default: true"),
    maxItems: z.number().optional().describe("Maximum number of added, removed, and changed elements to return. Default: 10"),
  },
  toolHandler(async ({ refresh, interactiveOnly, maxItems }) => {
    const session = requireSession();
    const shouldRefresh = refresh ?? true;
    if (shouldRefresh) {
      if (!session.lastSnapshot) {
        return {
          status: "error",
          error: "snapshot_diff needs a baseline snapshot first. Call 'snapshot' before the action you want to compare.",
        };
      }
      await captureSessionSnapshot(interactiveOnly ?? true);
    }

    const updatedSession = requireSession();
    if (!updatedSession.previousSnapshot || !updatedSession.lastSnapshot) {
      return {
        status: "error",
        error: "snapshot_diff needs two consecutive snapshots. Call 'snapshot', perform the action, then call 'snapshot_diff'.",
      };
    }

    const diff = compareSnapshots(updatedSession.previousSnapshot, updatedSession.lastSnapshot);
    const artifactPath = await writeDiffArtifact(diff);
    const limit = Math.max(1, maxItems ?? 10);

    return {
      ...diff,
      artifactPath,
      addedElements: diff.addedElements.slice(0, limit),
      removedElements: diff.removedElements.slice(0, limit),
      changedElements: diff.changedElements.slice(0, limit),
    };
  }),
);

server.tool(
  "wait_for_idle",
  "Wait until the current UI remains unchanged for a short quiet window. Useful after navigation, scrolls, and async loading.",
  {
    timeoutMs: z.number().optional().describe("Maximum wait time in milliseconds. Default: 10000"),
    idleMs: z.number().optional().describe("How long the UI must stay unchanged before considered idle. Default: 900"),
    pollIntervalMs: z.number().optional().describe("How often to re-snapshot while polling. Default: 350"),
    interactiveOnly: z.boolean().optional().describe("Only include interactive elements while checking for UI stability. Default: false"),
    ignoreTextualChanges: z.boolean().optional().describe("Ignore text-only churn such as timers or subtle labels. Default: true"),
    maxChangedElements: z.number().optional().describe("How many non-textual element changes are tolerated before resetting idle. Default: 1"),
    maxAddedElements: z.number().optional().describe("How many added elements are tolerated before resetting idle. Default: 0"),
    maxRemovedElements: z.number().optional().describe("How many removed elements are tolerated before resetting idle. Default: 0"),
  },
  toolHandler(async ({
    timeoutMs,
    idleMs,
    pollIntervalMs,
    interactiveOnly,
    ignoreTextualChanges,
    maxChangedElements,
    maxAddedElements,
    maxRemovedElements,
  }) => {
    const result = await waitForIdleState({
      timeoutMs: timeoutMs ?? 10_000,
      idleMs: idleMs ?? 900,
      pollIntervalMs: pollIntervalMs ?? 350,
      interactiveOnly: interactiveOnly ?? false,
      ignoreTextualChanges: ignoreTextualChanges ?? true,
      maxChangedElements: maxChangedElements ?? 1,
      maxAddedElements: maxAddedElements ?? 0,
      maxRemovedElements: maxRemovedElements ?? 0,
    });
    const session = requireSession();

    return {
      status: result.status,
      waitedMs: result.waitedMs,
      stableForMs: result.stableForMs,
      screen: result.snapshot.screen,
      package: result.snapshot.packageName,
      elementCount: result.snapshot.elements.length,
      artifactPath: session.lastSnapshotArtifactPath,
    };
  }),
);

server.tool(
  "scroll_until",
  "Repeatedly scroll in one direction until an element matching the selector appears or the limit is reached.",
  {
    ...elementQueryShape,
    direction: z.enum(["up", "down", "left", "right"]).describe("Direction of the content you want to reach"),
    maxScrolls: z.number().optional().describe("Maximum number of scroll attempts. Default: 8"),
    pauseMs: z.number().optional().describe("Pause after each scroll before re-checking. Default: 700"),
    interactiveOnly: z.boolean().optional().describe("Only inspect interactive elements while searching. Default: false"),
  },
  toolHandler(async (args) => {
    const query = normalizeElementQuery(args);
    if (isEmptyQuery(query)) {
      return {
        status: "error",
        error: "scroll_until requires at least one selector field such as text, resourceId, contentDesc, or testTag.",
      };
    }
    if (!hasPrimarySelectorFields(query)) {
      return {
        status: "error",
        error: "scroll_until needs a target selector in addition to nearText. Example: clickable=true + nearText='@rafael'.",
      };
    }

    const result = await scrollUntilMatch(query, {
      direction: args.direction,
      maxScrolls: args.maxScrolls ?? 8,
      pauseMs: args.pauseMs ?? 700,
      interactiveOnly: args.interactiveOnly ?? false,
    });
    const session = requireSession();

    return {
      status: result.matches.length > 0 ? "ok" : "not_found",
      direction: args.direction,
      query,
      queryDescription: describeQuery(query),
      scrollCount: result.scrollCount,
      screen: result.snapshot.screen,
      package: result.snapshot.packageName,
      matchCount: result.matches.length,
      artifactPath: session.lastSnapshotArtifactPath,
      firstMatch: result.matches[0]
        ? {
            ...result.matches[0],
            description: describeElement(result.matches[0]),
          }
        : null,
    };
  }),
);

server.tool(
  "wait_for_element",
  "Wait until an element matching the query appears in the current UI snapshot.",
  {
    ...elementQueryShape,
    timeoutMs: z.number().optional().describe("Maximum wait time in milliseconds. Default: 10000"),
    intervalMs: z.number().optional().describe("Polling interval in milliseconds. Default: 500"),
    interactiveOnly: z.boolean().optional().describe("Only inspect interactive elements while polling. Default: false"),
  },
  toolHandler(async (args) => {
    const query = normalizeElementQuery(args);
    if (isEmptyQuery(query)) {
      return {
        status: "error",
        error: "wait_for_element requires at least one selector field such as ref, text, resourceId, or contentDesc.",
      };
    }
    if (!hasPrimarySelectorFields(query)) {
      return {
        status: "error",
        error: "wait_for_element needs a target selector in addition to nearText. Example: textContains='Registrar' + nearText='@rafael'.",
      };
    }

    const result = await waitForElementMatch(query, {
      timeoutMs: args.timeoutMs ?? 10_000,
      intervalMs: args.intervalMs ?? 500,
      interactiveOnly: args.interactiveOnly ?? false,
    });

    return {
      status: result.matches.length > 0 ? "ok" : "timeout",
      query,
      queryDescription: describeQuery(query),
      waitedMs: result.waitedMs,
      screen: result.snapshot.screen,
      package: result.snapshot.packageName,
      matchCount: result.matches.length,
      firstMatch: result.matches[0]
        ? {
            ...result.matches[0],
            description: describeElement(result.matches[0]),
          }
        : null,
    };
  }),
);

server.tool(
  "assert_visible",
  "Assert that at least one element matching the query is visible in the current UI.",
  {
    ...elementQueryShape,
    refresh: z.boolean().optional().describe("Refresh the snapshot before asserting. Default: true"),
    interactiveOnly: z.boolean().optional().describe("Only inspect interactive elements. Default: false"),
  },
  toolHandler(async (args) => {
    const query = normalizeElementQuery(args);
    if (isEmptyQuery(query)) {
      return {
        status: "error",
        error: "assert_visible requires at least one selector field such as ref, text, resourceId, or contentDesc.",
      };
    }
    if (!hasPrimarySelectorFields(query)) {
      return {
        status: "error",
        error: "assert_visible needs a target selector in addition to nearText. Example: clickable=true + nearText='@rafael'.",
      };
    }

    const snapshot = await getSnapshotForAssertion(args.refresh ?? true, args.interactiveOnly ?? false);
    const matches = findMatchingElements(snapshot, query);

    return {
      status: matches.length > 0 ? "passed" : "failed",
      assertion: "visible",
      query,
      queryDescription: describeQuery(query),
      screen: snapshot.screen,
      package: snapshot.packageName,
      matchCount: matches.length,
      firstMatch: matches[0]
        ? {
            ...matches[0],
            description: describeElement(matches[0]),
          }
        : null,
    };
  }),
);

server.tool(
  "assert_text",
  "Assert that an element matching the query has the expected text, content description, or hint.",
  {
    ...elementQueryShape,
    expected: z.string().describe("Expected text value"),
    source: z.enum(["text", "contentDesc", "hint"]).optional().describe("Field to compare. Default: text"),
    match: z.enum(["equals", "contains"]).optional().describe("Comparison mode. Default: equals"),
    refresh: z.boolean().optional().describe("Refresh the snapshot before asserting. Default: true"),
    interactiveOnly: z.boolean().optional().describe("Only inspect interactive elements. Default: false"),
  },
  toolHandler(async (args) => {
    const query = normalizeElementQuery(args);
    if (isEmptyQuery(query)) {
      return {
        status: "error",
        error: "assert_text requires at least one selector field so DroidPilot knows which element to inspect.",
      };
    }
    if (!hasPrimarySelectorFields(query)) {
      return {
        status: "error",
        error: "assert_text needs a target selector in addition to nearText. Example: textContains='Registrar' + nearText='@rafael'.",
      };
    }

    const snapshot = await getSnapshotForAssertion(args.refresh ?? true, args.interactiveOnly ?? false);
    const matches = findMatchingElements(snapshot, query);
    const source = args.source ?? "text";
    const matchMode = args.match ?? "equals";
    const actual = matches[0]?.[source] ?? null;
    const passed = matchMode === "contains"
      ? (actual ?? "").toLowerCase().includes(args.expected.toLowerCase())
      : (actual ?? "").toLowerCase() === args.expected.toLowerCase();

    return {
      status: matches.length > 0 && passed ? "passed" : "failed",
      assertion: "text",
      query,
      queryDescription: describeQuery(query),
      source,
      match: matchMode,
      expected: args.expected,
      actual,
      screen: snapshot.screen,
      package: snapshot.packageName,
      matchCount: matches.length,
      firstMatch: matches[0]
        ? {
            ...matches[0],
            description: describeElement(matches[0]),
          }
        : null,
    };
  }),
);

server.tool(
  "assert_screen",
  "Assert the current package or screen/activity after a navigation or action.",
  {
    screen: z.string().optional().describe("Expected exact screen/activity"),
    screenContains: z.string().optional().describe("Expected substring within the current screen/activity"),
    package: z.string().optional().describe("Expected exact package name"),
    packageContains: z.string().optional().describe("Expected substring within the package name"),
    refresh: z.boolean().optional().describe("Refresh the snapshot before asserting. Default: true"),
  },
  toolHandler(async ({ screen, screenContains, package: expectedPackage, packageContains, refresh }) => {
    if (!screen && !screenContains && !expectedPackage && !packageContains) {
      return {
        status: "error",
        error: "assert_screen requires at least one expected field: screen, screenContains, package, or packageContains.",
      };
    }

    const snapshot = await getSnapshotForAssertion(refresh ?? true, false);
    const packageMatches =
      (expectedPackage === undefined || snapshot.packageName === expectedPackage) &&
      (packageContains === undefined || snapshot.packageName.toLowerCase().includes(packageContains.toLowerCase()));
    const screenMatches =
      (screen === undefined || snapshot.screen === screen) &&
      (screenContains === undefined || snapshot.screen.toLowerCase().includes(screenContains.toLowerCase()));

    return {
      status: packageMatches && screenMatches ? "passed" : "failed",
      assertion: "screen",
      expected: {
        screen: screen ?? null,
        screenContains: screenContains ?? null,
        package: expectedPackage ?? null,
        packageContains: packageContains ?? null,
      },
      actual: {
        screen: snapshot.screen,
        package: snapshot.packageName,
      },
    };
  }),
);

server.tool(
  "tap",
  "Tap a UI element by ref or semantic selector such as text, resourceId, or contentDesc.",
  {
    ...elementQueryShape,
    refresh: z.boolean().optional().describe("Refresh the snapshot before resolving non-ref selectors. Default: true"),
    interactiveOnly: z.boolean().optional().describe("Only inspect interactive elements when refreshing. Default: false"),
  },
  toolHandler(async (args) => {
    const target = await resolveActionTarget(args, { refreshDefault: true, interactiveOnlyDefault: false });
    if (!target.ok) {
      return {
        status: "error",
        error: target.error,
        query: target.query,
        queryDescription: target.queryDescription,
        screen: "screen" in target ? target.screen : undefined,
        package: "package" in target ? target.package : undefined,
        matchCount: "matchCount" in target ? target.matchCount : undefined,
      };
    }

    const session = requireSession();
    const result = await adb.tap(target.element.ref, target.snapshot, session.device?.serial);
    await new Promise((resolve) => setTimeout(resolve, 350));

    return {
      status: result.success ? "ok" : "failed",
      action: "tap",
      target: target.element.ref,
      query: target.query,
      queryDescription: target.queryDescription,
      matchCount: target.matchCount,
      matchedElement: {
        ...target.element,
        description: describeElement(target.element),
      },
      result: result.success ? "ok" : "failed",
      error: result.error,
    };
  }),
);

server.tool(
  "fill",
  "Fill a text field by ref or semantic selector. DroidPilot focuses the field, clears the current value, and types the new text.",
  {
    ...elementQueryShape,
    text: z.string().describe("Text to type into the field"),
    refresh: z.boolean().optional().describe("Refresh the snapshot before resolving non-ref selectors. Default: true"),
    interactiveOnly: z.boolean().optional().describe("Only inspect interactive elements when refreshing. Default: false"),
  },
  toolHandler(async (args) => {
    const target = await resolveActionTarget(args, { refreshDefault: true, interactiveOnlyDefault: false });
    if (!target.ok) {
      return {
        status: "error",
        error: target.error,
        query: target.query,
        queryDescription: target.queryDescription,
        screen: "screen" in target ? target.screen : undefined,
        package: "package" in target ? target.package : undefined,
        matchCount: "matchCount" in target ? target.matchCount : undefined,
      };
    }

    const session = requireSession();
    const result = await adb.fill(target.element.ref, args.text, target.snapshot, session.device?.serial);
    await new Promise((resolve) => setTimeout(resolve, 350));

    return {
      status: result.success ? "ok" : "failed",
      action: "fill",
      target: target.element.ref,
      text: args.text,
      query: target.query,
      queryDescription: target.queryDescription,
      matchCount: target.matchCount,
      matchedElement: {
        ...target.element,
        description: describeElement(target.element),
      },
      result: result.success ? "ok" : "failed",
      error: result.error,
    };
  }),
);

server.tool(
  "scroll",
  "Scroll in the direction of the content you want to reveal. Example: 'down' reveals lower items in a list.",
  {
    direction: z.enum(["up", "down", "left", "right"]).describe("Direction of the content you want to reach, not the finger gesture"),
  },
  toolHandler(async ({ direction }) => {
    const session = requireSession();
    await adb.scroll(direction, session.device?.serial);
    await new Promise((resolve) => setTimeout(resolve, 350));

    return {
      action: "scroll",
      direction,
      result: "ok",
    };
  }),
);

server.tool(
  "back",
  "Press the Android back button.",
  {},
  toolHandler(async () => {
    const session = requireSession();
    await adb.pressBack(session.device?.serial);
    await new Promise((resolve) => setTimeout(resolve, 250));

    return {
      action: "back",
      result: "ok",
    };
  }),
);

server.tool(
  "screenshot",
  "Capture a screenshot of the current screen and return the PNG path.",
  {
    outputPath: z.string().optional().describe("Optional target file path. Defaults to the temp directory."),
  },
  toolHandler(async ({ outputPath }) => {
    const session = requireSession();
    const artifactPath = outputPath ?? await nextSessionFileArtifactPath("screenshots", ".png");
    const path = await adb.takeScreenshot(artifactPath ?? undefined, session.device?.serial);

    return {
      status: "ok",
      action: "screenshot",
      path,
      result: "ok",
    };
  }),
);

server.tool(
  "artifacts",
  "Show the current session artifact directory and the files already captured for snapshots, diffs, screenshots, and videos.",
  {},
  toolHandler(async () => {
    const session = requireSession();
    if (!session.artifactsDir) {
      return {
        status: "error",
        error: "No artifact directory is configured for the current session.",
      };
    }

    return {
      status: "ok",
      artifactsDir: session.artifactsDir,
      lastSnapshotArtifactPath: session.lastSnapshotArtifactPath,
      lastDiffArtifactPath: session.lastDiffArtifactPath,
      recording: session.recording,
      files: await listArtifacts(session.artifactsDir),
    };
  }),
);

server.tool(
  "record_video_start",
  "Start recording the device screen into the current session artifact directory.",
  {
    outputPath: z.string().optional().describe("Optional final MP4 path. Defaults to the session videos folder."),
    bitRateMbps: z.number().optional().describe("Optional screenrecord bitrate in Mbps."),
    timeLimitSec: z.number().optional().describe("Optional device-side time limit in seconds. Maximum 180."),
  },
  toolHandler(async ({ outputPath, bitRateMbps, timeLimitSec }) => {
    const session = requireSession();
    if (session.recording) {
      return {
        status: "error",
        error: "A recording is already active for this session. Stop it before starting another one.",
        recording: session.recording,
      };
    }

    const localPath = outputPath ?? await nextSessionFileArtifactPath("videos", ".mp4");
    if (!localPath) {
      return {
        status: "error",
        error: "DroidPilot could not determine an output path for the video recording.",
      };
    }

    const remotePath = `/sdcard/Download/droidpilot-${Date.now()}.mp4`;
    const result = await adb.startScreenRecording(remotePath, {
      serial: session.device?.serial,
      bitRateMbps,
      timeLimitSec,
    });

    if (!result.success) {
      return {
        status: "failed",
        error: result.error,
      };
    }

    updateSession({
      recording: {
        remotePath,
        localPath,
        startedAt: Date.now(),
        serial: session.device?.serial ?? null,
      },
    });

    return {
      status: "recording",
      path: localPath,
      remotePath,
      startedAt: new Date().toISOString(),
    };
  }),
);

server.tool(
  "record_video_stop",
  "Stop the active screen recording and pull the MP4 into the session artifact directory.",
  {},
  toolHandler(async () => {
    const session = requireSession();
    if (!session.recording) {
      return {
        status: "error",
        error: "No active recording exists for this session.",
      };
    }

    const recording = session.recording;
    const result = await adb.stopScreenRecording(recording.localPath, {
      serial: session.device?.serial ?? undefined,
      remotePath: recording.remotePath,
    });
    updateSession({ recording: null });

    return {
      status: result.success ? "ok" : "failed",
      path: result.path ?? recording.localPath,
      durationMs: result.durationMs,
      error: result.error,
    };
  }),
);

server.tool(
  "logs",
  "Get recent app logs (logcat), using session or launch baselines and the latest known app PID when possible.",
  {
    maxLines: z.number().optional().describe("Max log lines to return. Default: 50"),
    scope: z.enum(["session", "launch"]).optional().describe("Choose the baseline for log collection. Default: launch when available, otherwise session."),
  },
  toolHandler(async ({ maxLines, scope }) => {
    const session = requireSession();
    const packageName = normalizePackageName();
    if (!packageName) {
      return { status: "error", error: "No package name is known yet. Run the app first." };
    }

    const effectiveScope = scope ?? (session.launchBaselineEpochMs ? "launch" : "session");
    const baselineEpochMs = effectiveScope === "launch"
      ? (session.launchBaselineEpochMs ?? session.logBaselineEpochMs)
      : session.logBaselineEpochMs;
    const currentPid = await adb.getAppPid(packageName, session.device?.serial);
    const logsPid = currentPid ?? session.lastKnownPid;
    updateSession({ lastKnownPid: logsPid ?? null });
    const result = await adb.getAppLogs(packageName, {
      maxLines: maxLines ?? 50,
      serial: session.device?.serial,
      sinceEpochMs: baselineEpochMs,
      pid: logsPid,
    });

    return {
      status: "ok",
      scope: effectiveScope,
      package: packageName,
      pid: currentPid,
      logsPid: result.pid,
      baselineEpochMs,
      lineCount: result.lines.length,
      crashCount: result.crashes.length,
      crashes: result.crashes,
      lines: result.lines,
    };
  }),
);

server.tool(
  "health",
  "Check whether the app is running, its memory usage, and whether logs since this session or launch indicate crashes.",
  {},
  toolHandler(async () => {
    const session = requireSession();
    const packageName = normalizePackageName();
    if (!packageName) {
      return { status: "error", error: "No package name is known yet. Run the app first." };
    }

    const currentPid = await adb.getAppPid(packageName, session.device?.serial);
    const logsPid = currentPid ?? session.lastKnownPid;
    updateSession({ lastKnownPid: logsPid ?? null });
    const result = await adb.checkHealth(packageName, {
      serial: session.device?.serial,
      pid: logsPid,
      sessionBaselineEpochMs: session.logBaselineEpochMs,
      launchBaselineEpochMs: session.launchBaselineEpochMs,
    });
    return {
      status: "ok",
      package: packageName,
      sessionLogBaselineEpochMs: session.logBaselineEpochMs,
      launchLogBaselineEpochMs: session.launchBaselineEpochMs,
      ...result,
    };
  }),
);

server.tool(
  "devices",
  "List all connected Android devices and emulators, plus the device DroidPilot would pick by default.",
  {},
  toolHandler(async () => {
    const devices = await adb.listDevices();
    const defaultDevice = await adb.getActiveDevice(undefined, true);

    return {
      adbPath: await adb.getAdbPath(),
      defaultDeviceSerial: defaultDevice?.serial ?? null,
      devices,
    };
  }),
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("DroidPilot MCP server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
