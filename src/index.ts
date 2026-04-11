#!/usr/bin/env node

/**
 * DroidPilot MCP Server
 *
 * A robust MCP server that lets AI coding agents build, deploy,
 * inspect, and interact with Android apps on emulators/devices.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod/v4";

import { AdbError } from "./engines/adb.js";
import * as adb from "./engines/adb.js";
import { GradleError } from "./engines/gradle.js";
import * as gradle from "./engines/gradle.js";
import {
  closeSession,
  createSession,
  getSession,
  requireSession,
  updateSession,
} from "./engines/session.js";

const server = new McpServer({
  name: "droidpilot",
  version: "0.2.0",
});

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

async function waitForApp(packageName: string, serial?: string, timeoutMs: number = 10_000): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await adb.isAppRunning(packageName, serial)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

server.tool(
  "open",
  "Open a DroidPilot session. Detects the Android project, chooses a ready emulator by default, and prepares for build/test.",
  {
    projectDir: z.string().describe("Path to the Android project root (where settings.gradle lives)"),
    deviceSerial: z.string().optional().describe("Specific device/emulator serial to use, e.g. 'emulator-5554'"),
    preferEmulator: z.boolean().optional().describe("Prefer an emulator over a physical device. Default: true"),
  },
  toolHandler(async ({ projectDir, deviceSerial, preferEmulator }) => {
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
    updateSession({
      project,
      device,
      packageName: project.applicationId ?? null,
    });

    return {
      status: "ok",
      session: session.id,
      adbPath: await adb.getAdbPath(),
      project: {
        dir: project.projectDir,
        module: project.rootModule,
        applicationId: project.applicationId,
        buildVariant: project.buildVariant,
      },
      device,
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
    updateSession({
      packageName,
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
    const session = requireSession();
    const snapshot = await adb.captureSnapshot(interactiveOnly ?? true, session.device?.serial);
    updateSession({ lastSnapshot: snapshot });

    return {
      status: "ok",
      screen: snapshot.screen,
      package: snapshot.packageName,
      elementCount: snapshot.elements.length,
      elements: snapshot.elements.map((element) => ({
        ref: element.ref,
        type: element.type,
        text: element.text,
        hint: element.hint,
        contentDesc: element.contentDesc,
        resourceId: element.resourceId,
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
  "tap",
  "Tap a UI element by ref (for example @e1).",
  {
    ref: z.string().describe("Element reference from snapshot, e.g. '@e1'"),
  },
  toolHandler(async ({ ref }) => {
    const session = requireSession();
    if (!session.lastSnapshot) {
      return { status: "error", error: "No snapshot available. Call 'snapshot' first." };
    }

    const result = await adb.tap(ref, session.lastSnapshot, session.device?.serial);
    await new Promise((resolve) => setTimeout(resolve, 350));

    return {
      action: "tap",
      target: ref,
      result: result.success ? "ok" : "failed",
      error: result.error,
    };
  }),
);

server.tool(
  "fill",
  "Fill a text field by ref. DroidPilot focuses the field, clears the current value, and types the new text.",
  {
    ref: z.string().describe("Element reference from snapshot, e.g. '@e2'"),
    text: z.string().describe("Text to type into the field"),
  },
  toolHandler(async ({ ref, text }) => {
    const session = requireSession();
    if (!session.lastSnapshot) {
      return { status: "error", error: "No snapshot available. Call 'snapshot' first." };
    }

    const result = await adb.fill(ref, text, session.lastSnapshot, session.device?.serial);
    await new Promise((resolve) => setTimeout(resolve, 350));

    return {
      action: "fill",
      target: ref,
      text,
      result: result.success ? "ok" : "failed",
      error: result.error,
    };
  }),
);

server.tool(
  "scroll",
  "Scroll the screen in a direction.",
  {
    direction: z.enum(["up", "down", "left", "right"]).describe("Scroll direction"),
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
    const path = await adb.takeScreenshot(outputPath, session.device?.serial);

    return {
      action: "screenshot",
      path,
      result: "ok",
    };
  }),
);

server.tool(
  "logs",
  "Get recent app logs (logcat), filtered by the app PID when possible.",
  {
    maxLines: z.number().optional().describe("Max log lines to return. Default: 50"),
  },
  toolHandler(async ({ maxLines }) => {
    const session = requireSession();
    const packageName = normalizePackageName();
    if (!packageName) {
      return { status: "error", error: "No package name is known yet. Run the app first." };
    }

    const result = await adb.getAppLogs(packageName, maxLines ?? 50, session.device?.serial);

    return {
      package: packageName,
      lineCount: result.lines.length,
      crashCount: result.crashes.length,
      crashes: result.crashes,
      lines: result.lines.slice(-Math.min(result.lines.length, maxLines ?? 50)),
    };
  }),
);

server.tool(
  "health",
  "Check whether the app is running, its memory usage, and whether recent logs indicate crashes.",
  {},
  toolHandler(async () => {
    const session = requireSession();
    const packageName = normalizePackageName();
    if (!packageName) {
      return { status: "error", error: "No package name is known yet. Run the app first." };
    }

    const result = await adb.checkHealth(packageName, session.device?.serial);
    return {
      package: packageName,
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
