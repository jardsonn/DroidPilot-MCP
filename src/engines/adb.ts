/**
 * ADB Engine - Wrapper over Android Debug Bridge (adb)
 *
 * Handles SDK discovery, device selection, app install/launch,
 * UI inspection, screenshots, interaction, and logcat.
 */

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import process from "node:process";
import { promisify } from "node:util";

import { XMLParser } from "fast-xml-parser";

const exec = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024;
const FALLBACK_DISPLAY = { width: 1080, height: 2400 };

const uiXmlParser = new XMLParser({
  attributeNamePrefix: "",
  ignoreAttributes: false,
  processEntities: true,
  trimValues: false,
});

let cachedAdbPathPromise: Promise<string> | null = null;
const activeRecordings = new Map<string, {
  process: ChildProcess;
  remotePath: string;
  startedAt: number;
  stdout: string[];
  stderr: string[];
}>();

export class AdbError extends Error {
  constructor(
    public readonly code:
      | "ADB_NOT_FOUND"
      | "ADB_COMMAND_FAILED"
      | "DEVICE_NOT_FOUND"
      | "UI_DUMP_INVALID",
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "AdbError";
  }
}

export interface Device {
  serial: string;
  type: "emulator" | "device";
  model?: string;
  apiLevel?: string;
  status: "device" | "offline" | "unauthorized";
  transportId?: string;
}

export interface UIElement {
  ref: string;
  type: string;
  text?: string;
  hint?: string;
  contentDesc?: string;
  resourceId?: string;
  testTag?: string;
  label?: string;
  parentRef?: string;
  nodePath?: string;
  containerPath?: string;
  depth?: number;
  parentText?: string;
  childText?: string;
  siblingText?: string;
  contextText?: string;
  bounds: [number, number, number, number];
  clickable: boolean;
  focusable: boolean;
  scrollable: boolean;
  enabled: boolean;
  editable: boolean;
  checked: boolean;
  selected: boolean;
}

export interface Snapshot {
  screen: string;
  packageName: string;
  elements: UIElement[];
  timestamp: number;
}

export interface LogEntry {
  epochMs: number;
  pid: number | null;
  tid: number | null;
  priority: string;
  tag: string;
  message: string;
  raw: string;
}

export interface AppLogResult {
  baselineEpochMs: number | null;
  pid: number | null;
  lines: string[];
  entries: LogEntry[];
  crashes: string[];
}

interface AdbCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  command: string[];
}

interface RawUiNode {
  node?: RawUiNode | RawUiNode[];
  [key: string]: unknown;
}

interface ParsedUiNode {
  path: string;
  depth: number;
  className: string;
  text?: string;
  hint?: string;
  contentDesc?: string;
  resourceId?: string;
  testTag?: string;
  bounds: [number, number, number, number];
  clickable: boolean;
  focusable: boolean;
  scrollable: boolean;
  enabled: boolean;
  editable: boolean;
  checked: boolean;
  selected: boolean;
  visible: boolean;
  keep: boolean;
  ownTexts: string[];
  subtreeTexts: string[];
  parent?: ParsedUiNode;
  children: ParsedUiNode[];
}

const LOGCAT_EPOCH_PATTERN =
  /^\s*(\d+(?:\.\d+)?)\s+(\d+)\s+(\d+)\s+([VDIWEAF])\s+([^:]+):\s?(.*)$/;
const MAX_CONTEXT_TOKENS = 8;

function dedupe(values: Array<string | undefined | null>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value?.trim())).map((value) => value.trim()))];
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function getSdkRoots(): string[] {
  const localAppData = process.env.LOCALAPPDATA;
  const userProfile = process.env.USERPROFILE;
  const home = process.env.HOME ?? userProfile;
  return dedupe([
    process.env.ANDROID_SDK_ROOT,
    process.env.ANDROID_HOME,
    localAppData ? join(localAppData, "Android", "Sdk") : null,
    userProfile ? join(userProfile, "AppData", "Local", "Android", "Sdk") : null,
    home ? join(home, "Android", "Sdk") : null,
  ]);
}

async function resolveOnPath(binary: string): Promise<string | null> {
  const locator = process.platform === "win32" ? "where.exe" : "which";
  try {
    const { stdout } = await exec(locator, [binary], {
      timeout: 5_000,
      maxBuffer: 256 * 1024,
    });
    const first = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    return first ?? null;
  } catch {
    return null;
  }
}

async function resolveAdbPath(): Promise<string> {
  cachedAdbPathPromise ??= (async () => {
    const adbBinary = process.platform === "win32" ? "adb.exe" : "adb";
    const candidates = dedupe([
      ...getSdkRoots().map((root) => join(root, "platform-tools", adbBinary)),
      process.env.ADB_PATH,
    ]);

    for (const candidate of candidates) {
      if (await fileExists(candidate)) {
        return candidate;
      }
    }

    const fromPath = await resolveOnPath(process.platform === "win32" ? "adb.exe" : "adb");
    if (fromPath) {
      return fromPath;
    }

    throw new AdbError(
      "ADB_NOT_FOUND",
      "Android Debug Bridge (adb) was not found. Install Android SDK Platform-Tools or configure ANDROID_SDK_ROOT/ANDROID_HOME.",
      { checkedPaths: candidates },
    );
  })();

  return cachedAdbPathPromise;
}

export async function getAdbPath(): Promise<string> {
  return resolveAdbPath();
}

async function adb(
  args: string[],
  serial?: string,
  options?: { allowFailure?: boolean; timeoutMs?: number },
): Promise<AdbCommandResult> {
  const adbPath = await resolveAdbPath();
  const fullArgs = serial ? ["-s", serial, ...args] : args;

  try {
    const result = await exec(adbPath, fullArgs, {
      timeout: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBuffer: DEFAULT_MAX_BUFFER,
    });

    return {
      stdout: result.stdout,
      stderr: result.stderr ?? "",
      exitCode: 0,
      command: [adbPath, ...fullArgs],
    };
  } catch (error: any) {
    const stdout = error?.stdout ?? "";
    const stderr = error?.stderr ?? error?.message ?? "Unknown adb failure";
    const exitCode = typeof error?.code === "number" ? error.code : null;
    const result: AdbCommandResult = {
      stdout,
      stderr,
      exitCode,
      command: [adbPath, ...fullArgs],
    };

    if (options?.allowFailure) {
      return result;
    }

    throw new AdbError(
      "ADB_COMMAND_FAILED",
      `adb command failed: ${[basename(adbPath), ...fullArgs].join(" ")}`,
      result,
    );
  }
}

function recordingKey(serial?: string): string {
  return serial ?? "__default__";
}

async function waitForProcessExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<{ exited: boolean; code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve({ exited: false, code: null, signal: null });
      }
    }, timeoutMs);

    child.once("exit", (code, signal) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ exited: true, code, signal });
      }
    });
  });
}

function parseDeviceLine(line: string): Device | null {
  const match = line.match(/^(\S+)\s+(device|offline|unauthorized)\s*(.*)$/);
  if (!match) {
    return null;
  }

  const [, serial, status, info] = match;
  const modelMatch = info.match(/model:(\S+)/);
  const transportMatch = info.match(/transport_id:(\S+)/);

  return {
    serial,
    type: serial.startsWith("emulator-") ? "emulator" : "device",
    model: modelMatch?.[1]?.replace(/_/g, " "),
    transportId: transportMatch?.[1],
    status: status as Device["status"],
  };
}

export async function listDevices(): Promise<Device[]> {
  const { stdout } = await adb(["devices", "-l"]);
  const devices = stdout
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseDeviceLine)
    .filter((device): device is Device => device !== null);

  await Promise.all(
    devices.map(async (device) => {
      if (device.status !== "device") {
        return;
      }

      const apiResult = await adb(
        ["shell", "getprop", "ro.build.version.sdk"],
        device.serial,
        { allowFailure: true },
      );

      device.apiLevel = apiResult.stdout.trim() || undefined;
    }),
  );

  return devices;
}

export async function getDevice(serial: string): Promise<Device | null> {
  const devices = await listDevices();
  return devices.find((device) => device.serial === serial) ?? null;
}

export async function getActiveDevice(
  preferredSerial?: string,
  preferEmulator: boolean = true,
): Promise<Device | null> {
  const devices = await listDevices();
  const ready = devices.filter((device) => device.status === "device");

  if (preferredSerial) {
    const explicit = ready.find((device) => device.serial === preferredSerial);
    if (!explicit) {
      throw new AdbError(
        "DEVICE_NOT_FOUND",
        `Requested device '${preferredSerial}' is not connected or is not ready.`,
        { availableDevices: ready.map((device) => device.serial) },
      );
    }
    return explicit;
  }

  if (preferEmulator) {
    return ready.find((device) => device.type === "emulator") ?? ready[0] ?? null;
  }

  return ready[0] ?? null;
}

function parseAmStartOutput(output: string): boolean {
  return /(^|\s)Error:|Exception|does not exist|SecurityException/i.test(output);
}

function parseResolvedActivity(output: string): string | null {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  return [...lines].reverse().find((line) => line.includes("/")) ?? null;
}

export async function resolveLaunchableActivity(
  packageName: string,
  serial?: string,
): Promise<string | null> {
  const resolveResult = await adb(
    ["shell", "cmd", "package", "resolve-activity", "--brief", packageName],
    serial,
    { allowFailure: true, timeoutMs: 10_000 },
  );
  const resolved = parseResolvedActivity(resolveResult.stdout);
  if (resolved) {
    return resolved;
  }

  const dumpsys = await adb(
    ["shell", "dumpsys", "package", packageName],
    serial,
    { allowFailure: true, timeoutMs: 15_000 },
  );

  const candidates = [
    dumpsys.stdout.match(/android\.intent\.category\.LAUNCHER:[\s\S]*?(\S+\/\S+)/),
    dumpsys.stdout.match(/Activity Resolver Table:[\s\S]*?(\S+\/\S+)/),
    dumpsys.stdout.match(new RegExp(`${packageName}\\/\\S+`)),
  ];

  for (const candidate of candidates) {
    if (candidate?.[1]) {
      return candidate[1];
    }
    if (candidate?.[0]) {
      return candidate[0];
    }
  }

  return null;
}

export async function installApk(
  apkPath: string,
  serial?: string,
): Promise<{ success: boolean; error?: string }> {
  const result = await adb(
    ["install", "-r", "-t", apkPath],
    serial,
    { allowFailure: true, timeoutMs: 180_000 },
  );
  const output = `${result.stdout}\n${result.stderr}`.trim();

  if (/Success/i.test(output)) {
    return { success: true };
  }

  return {
    success: false,
    error: output || "adb install did not report success.",
  };
}

export async function launchApp(
  packageName: string,
  activity?: string | null,
  serial?: string,
): Promise<{ success: boolean; error?: string; component?: string }> {
  const component =
    activity && activity.includes("/")
      ? activity
      : activity
        ? `${packageName}/${activity}`
        : await resolveLaunchableActivity(packageName, serial);

  if (component) {
    const startResult = await adb(
      ["shell", "am", "start", "-W", "-n", component],
      serial,
      { allowFailure: true, timeoutMs: 30_000 },
    );
    const output = `${startResult.stdout}\n${startResult.stderr}`;
    if (!parseAmStartOutput(output)) {
      return { success: true, component };
    }
  }

  const monkeyResult = await adb(
    ["shell", "monkey", "-p", packageName, "-c", "android.intent.category.LAUNCHER", "1"],
    serial,
    { allowFailure: true, timeoutMs: 30_000 },
  );
  const monkeyOutput = `${monkeyResult.stdout}\n${monkeyResult.stderr}`.trim();

  if (/Events injected:\s*1/i.test(monkeyOutput) && !/No activities found/i.test(monkeyOutput)) {
    return { success: true, component: component ?? undefined };
  }

  return {
    success: false,
    error: monkeyOutput || "Failed to launch app via am start and monkey fallback.",
    component: component ?? undefined,
  };
}

export async function openDeeplink(
  uri: string,
  options?: {
    packageName?: string | null;
    serial?: string;
  },
): Promise<{ success: boolean; error?: string; component?: string }> {
  const args = [
    "shell",
    "am",
    "start",
    "-W",
    "-a",
    "android.intent.action.VIEW",
    "-d",
    uri,
  ];

  if (options?.packageName) {
    args.push("-p", options.packageName);
  }

  const result = await adb(args, options?.serial, { allowFailure: true, timeoutMs: 30_000 });
  const output = `${result.stdout}\n${result.stderr}`;
  if (parseAmStartOutput(output)) {
    return {
      success: false,
      error: output.trim() || `Failed to open deeplink '${uri}'.`,
    };
  }

  return {
    success: true,
    component: parseResolvedActivity(result.stdout) ?? undefined,
  };
}

export async function stopApp(
  packageName: string,
  serial?: string,
): Promise<void> {
  await adb(["shell", "am", "force-stop", packageName], serial, { allowFailure: true });
}

export async function isAppRunning(
  packageName: string,
  serial?: string,
): Promise<boolean> {
  const result = await adb(["shell", "pidof", packageName], serial, { allowFailure: true });
  return result.stdout.trim().length > 0;
}

export async function getAppPid(
  packageName: string,
  serial?: string,
): Promise<number | null> {
  const result = await adb(["shell", "pidof", packageName], serial, { allowFailure: true });
  const raw = result.stdout.trim();
  if (!raw) {
    return null;
  }

  const firstPid = raw.split(/\s+/)[0];
  const parsed = Number.parseInt(firstPid, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

async function getCurrentScreen(serial?: string): Promise<string> {
  const activityDump = await adb(
    ["shell", "dumpsys", "activity", "activities"],
    serial,
    { allowFailure: true, timeoutMs: 15_000 },
  );
  const activityText = activityDump.stdout;
  const activityPatterns = [
    /topResumedActivity=.*? (\S+\/\S+)/,
    /mResumedActivity:.*? (\S+\/\S+)/,
    /ResumedActivity:.*? (\S+\/\S+)/,
  ];

  for (const pattern of activityPatterns) {
    const match = activityText.match(pattern);
    if (match?.[1]) {
      return match[1];
    }
  }

  const windowDump = await adb(
    ["shell", "dumpsys", "window", "windows"],
    serial,
    { allowFailure: true, timeoutMs: 15_000 },
  );
  const currentFocus = windowDump.stdout.match(/mCurrentFocus=.*? (\S+\/\S+)/);
  return currentFocus?.[1] ?? "unknown";
}

async function getDisplaySize(serial?: string): Promise<{ width: number; height: number }> {
  const result = await adb(
    ["shell", "wm", "size"],
    serial,
    { allowFailure: true, timeoutMs: 10_000 },
  );
  const match = result.stdout.match(/Physical size:\s*(\d+)x(\d+)/);
  if (!match) {
    return FALLBACK_DISPLAY;
  }

  return {
    width: parseInt(match[1], 10),
    height: parseInt(match[2], 10),
  };
}

function parseBounds(bounds: string): [number, number, number, number] {
  const match = bounds.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
  if (!match) {
    return [0, 0, 0, 0];
  }

  return [
    parseInt(match[1], 10),
    parseInt(match[2], 10),
    parseInt(match[3], 10),
    parseInt(match[4], 10),
  ];
}

function asBoolean(value: unknown): boolean {
  return value === true || value === "true";
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function uniqueTextTokens(...groups: Array<string | undefined | string[]>): string[] {
  const tokens = groups.flatMap((group) => {
    if (Array.isArray(group)) {
      return group;
    }
    return group ? [group] : [];
  });

  return [...new Set(
    tokens
      .map((token) => token.trim())
      .filter((token) => token.length > 0),
  )].slice(0, MAX_CONTEXT_TOKENS);
}

function summarizeTextTokens(tokens: string[]): string | undefined {
  const normalized = uniqueTextTokens(tokens);
  return normalized.length > 0 ? normalized.join(" | ") : undefined;
}

export function extractComposeTestTag(resourceId: string | undefined): string | undefined {
  if (!resourceId) {
    return undefined;
  }

  const normalized = resourceId.trim();
  if (!normalized) {
    return undefined;
  }

  if (normalized.includes(":id/")) {
    return normalized.slice(normalized.indexOf(":id/") + 4).trim() || undefined;
  }

  if (normalized.includes("/")) {
    return normalized.slice(normalized.lastIndexOf("/") + 1).trim() || undefined;
  }

  return normalized;
}

export function formatLogcatEpoch(epochMs: number): string {
  return (epochMs / 1000).toFixed(3);
}

export function parseLogcatEntries(output: string): LogEntry[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0 && !line.startsWith("---------"))
    .reduce<LogEntry[]>((entries, line) => {
      const match = line.match(LOGCAT_EPOCH_PATTERN);
      if (!match) {
        return entries;
      }

      const [, epochSeconds, pid, tid, priority, tag, message] = match;
      entries.push({
        epochMs: Math.round(Number.parseFloat(epochSeconds) * 1000),
        pid: Number.parseInt(pid, 10),
        tid: Number.parseInt(tid, 10),
        priority,
        tag: tag.trim(),
        message,
        raw: line,
      });
      return entries;
    }, []);
}

function isCrashEntry(entry: LogEntry): boolean {
  return (
    entry.tag.includes("AndroidRuntime") ||
    entry.message.includes("FATAL EXCEPTION") ||
    entry.message.includes("Process: ") ||
    entry.message.includes(" ANR in ")
  );
}

export function extractCrashSummaries(
  entries: LogEntry[],
  options?: { packageName?: string; pid?: number | null },
): string[] {
  const packageName = options?.packageName?.toLowerCase();
  const targetPid = options?.pid ?? null;
  const windows = new Map<number, LogEntry[]>();

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!isCrashEntry(entry)) {
      continue;
    }

    const pid = entry.pid ?? targetPid ?? -1;
    const currentWindow = windows.get(pid) ?? [];
    for (let cursor = index; cursor < Math.min(entries.length, index + 12); cursor += 1) {
      const candidate = entries[cursor];
      if (targetPid !== null && candidate.pid !== targetPid) {
        continue;
      }
      currentWindow.push(candidate);
    }
    windows.set(pid, currentWindow);
  }

  return [...windows.values()]
    .map((windowEntries) => {
      const raw = [...new Set(windowEntries.map((entry) => entry.raw))].join("\n");
      const matchesPackage = packageName
        ? raw.toLowerCase().includes(packageName)
        : true;
      return matchesPackage ? raw : null;
    })
    .filter((value): value is string => value !== null);
}

function isInteractiveNode(node: RawUiNode): boolean {
  return (
    asBoolean(node.clickable) ||
    asBoolean(node.focusable) ||
    asBoolean(node.scrollable) ||
    asBoolean(node.editable) ||
    asBoolean(node["long-clickable"])
  );
}

function flattenChildren(node: RawUiNode): RawUiNode[] {
  const child = node.node;
  if (!child) {
    return [];
  }
  return Array.isArray(child) ? child : [child];
}

function buildParsedUiNode(
  rawNode: RawUiNode,
  interactiveOnly: boolean,
  path: string,
  depth: number,
  parent?: ParsedUiNode,
): ParsedUiNode {
  const clickable = asBoolean(rawNode.clickable);
  const focusable = asBoolean(rawNode.focusable);
  const scrollable = asBoolean(rawNode.scrollable);
  const editable = asBoolean(rawNode.editable);
  const enabled = rawNode.enabled === undefined ? true : asBoolean(rawNode.enabled);
  const checked = asBoolean(rawNode.checked);
  const selected = asBoolean(rawNode.selected);
  const visible = rawNode["visible-to-user"] === undefined ? true : asBoolean(rawNode["visible-to-user"]);
  const text = asString(rawNode.text);
  const hint = asString(rawNode.hint);
  const contentDesc = asString(rawNode["content-desc"]);
  const resourceId = asString(rawNode["resource-id"]);
  const testTag = extractComposeTestTag(resourceId);
  const ownTexts = uniqueTextTokens(text, contentDesc, hint);
  const className = asString(rawNode.class) ?? "android.view.View";

  const parsedNode: ParsedUiNode = {
    path,
    depth,
    className,
    text,
    hint,
    contentDesc,
    resourceId,
    testTag,
    bounds: parseBounds(asString(rawNode.bounds) ?? ""),
    clickable,
    focusable,
    scrollable,
    enabled,
    editable,
    checked,
    selected,
    visible,
    keep: false,
    ownTexts,
    subtreeTexts: [],
    parent,
    children: [],
  };

  parsedNode.children = flattenChildren(rawNode).map((child, index) =>
    buildParsedUiNode(child, interactiveOnly, `${path}.${index}`, depth + 1, parsedNode),
  );
  parsedNode.subtreeTexts = uniqueTextTokens(
    parsedNode.ownTexts,
    ...parsedNode.children.map((child) => child.subtreeTexts),
  );

  parsedNode.keep =
    parsedNode.visible &&
    (!interactiveOnly || isInteractiveNode(rawNode)) &&
    (isInteractiveNode(rawNode) || parsedNode.ownTexts.length > 0 || Boolean(resourceId) || Boolean(testTag));

  return parsedNode;
}

function collectNearestAncestorTexts(node: ParsedUiNode): string[] {
  let current = node.parent;
  while (current) {
    if (current.ownTexts.length > 0) {
      return current.ownTexts;
    }
    current = current.parent;
  }
  return [];
}

function collectSiblingTexts(node: ParsedUiNode): string[] {
  if (!node.parent) {
    return [];
  }

  return uniqueTextTokens(
    ...node.parent.children
      .filter((candidate) => candidate.path !== node.path)
      .map((candidate) => candidate.subtreeTexts),
  );
}

function flattenParsedUiTree(rootNode: ParsedUiNode): UIElement[] {
  const elements: UIElement[] = [];
  let refCounter = 1;

  const visit = (node: ParsedUiNode, nearestKeptAncestorRef?: string) => {
    let nextAncestorRef = nearestKeptAncestorRef;

    if (node.keep) {
      const ref = `@e${refCounter++}`;
      const parentTexts = collectNearestAncestorTexts(node);
      const childTexts = uniqueTextTokens(...node.children.map((child) => child.subtreeTexts));
      const siblingTexts = collectSiblingTexts(node);
      const contextTexts = uniqueTextTokens(node.ownTexts, childTexts, siblingTexts, parentTexts, node.testTag);
      const label = uniqueTextTokens(node.ownTexts, childTexts, siblingTexts, parentTexts, node.testTag)[0];

      elements.push({
        ref,
        type: node.className.split(".").pop() ?? node.className,
        text: node.text,
        hint: node.hint,
        contentDesc: node.contentDesc,
        resourceId: node.resourceId,
        testTag: node.testTag,
        label,
        parentRef: nearestKeptAncestorRef,
        nodePath: node.path,
        containerPath: node.parent?.path,
        depth: node.depth,
        parentText: summarizeTextTokens(parentTexts),
        childText: summarizeTextTokens(childTexts),
        siblingText: summarizeTextTokens(siblingTexts),
        contextText: summarizeTextTokens(contextTexts),
        bounds: node.bounds,
        clickable: node.clickable,
        focusable: node.focusable,
        scrollable: node.scrollable,
        enabled: node.enabled,
        editable: node.editable,
        checked: node.checked,
        selected: node.selected,
      });
      nextAncestorRef = ref;
    }

    for (const child of node.children) {
      visit(child, nextAncestorRef);
    }
  };

  for (const child of rootNode.children) {
    visit(child);
  }

  return elements;
}

function parseUiDump(xml: string, interactiveOnly: boolean): UIElement[] {
  const parsed = uiXmlParser.parse(xml) as { hierarchy?: RawUiNode };
  const rootNode = parsed.hierarchy;

  if (!rootNode) {
    throw new AdbError("UI_DUMP_INVALID", "uiautomator dump did not produce a readable hierarchy.");
  }

  const parsedRoot = buildParsedUiNode(rootNode, interactiveOnly, "0", 0);
  return flattenParsedUiTree(parsedRoot);
}

export async function captureSnapshot(
  interactiveOnly: boolean = false,
  serial?: string,
): Promise<Snapshot> {
  const remotePath = "/data/local/tmp/droidpilot_ui.xml";
  await adb(["shell", "uiautomator", "dump", remotePath], serial, { timeoutMs: 30_000 });

  const xmlResult = await adb(["shell", "cat", remotePath], serial, { timeoutMs: 15_000 });
  await adb(["shell", "rm", remotePath], serial, { allowFailure: true });

  const screen = await getCurrentScreen(serial);
  const packageName = screen.includes("/") ? screen.split("/")[0] : "unknown";

  return {
    screen,
    packageName,
    elements: parseUiDump(xmlResult.stdout, interactiveOnly),
    timestamp: Date.now(),
  };
}

export async function takeScreenshot(
  outputPath?: string,
  serial?: string,
): Promise<string> {
  const localPath = outputPath ?? join(tmpdir(), `droidpilot_${Date.now()}.png`);
  const remotePath = "/data/local/tmp/droidpilot_screen.png";

  await adb(["shell", "screencap", "-p", remotePath], serial, { timeoutMs: 20_000 });
  const pullResult = await adb(["pull", remotePath, localPath], serial, {
    allowFailure: true,
    timeoutMs: 60_000,
  });
  await adb(["shell", "rm", remotePath], serial, { allowFailure: true });

  const output = `${pullResult.stdout}\n${pullResult.stderr}`;
  if (/error|failed/i.test(output)) {
    throw new AdbError("ADB_COMMAND_FAILED", "Failed to pull screenshot from device.", pullResult);
  }

  return localPath;
}

export async function startScreenRecording(
  remotePath: string,
  options?: {
    serial?: string;
    bitRateMbps?: number;
    timeLimitSec?: number;
  },
): Promise<{ success: boolean; error?: string; remotePath?: string }> {
  const key = recordingKey(options?.serial);
  if (activeRecordings.has(key)) {
    return {
      success: false,
      error: "A screen recording is already active for this device/session.",
    };
  }

  const adbPath = await resolveAdbPath();
  const args = [
    ...(options?.serial ? ["-s", options.serial] : []),
    "shell",
    "screenrecord",
  ];

  if (options?.bitRateMbps) {
    args.push("--bit-rate", String(Math.round(options.bitRateMbps * 1_000_000)));
  }
  if (options?.timeLimitSec) {
    args.push("--time-limit", String(Math.max(1, Math.min(180, Math.round(options.timeLimitSec)))));
  }

  args.push(remotePath);

  const child = spawn(adbPath, args, {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  const stdout: string[] = [];
  const stderr: string[] = [];
  child.stdout.on("data", (chunk) => stdout.push(String(chunk)));
  child.stderr.on("data", (chunk) => stderr.push(String(chunk)));

  activeRecordings.set(key, {
    process: child,
    remotePath,
    startedAt: Date.now(),
    stdout,
    stderr,
  });

  const startup = await waitForProcessExit(child, 700);
  if (startup.exited) {
    activeRecordings.delete(key);
    return {
      success: false,
      error: [...stdout, ...stderr].join("").trim() || "screenrecord exited before it could start.",
    };
  }

  return {
    success: true,
    remotePath,
  };
}

async function requestRemoteScreenRecordingStop(serial?: string): Promise<void> {
  const stopCommands = [
    ["shell", "pkill", "-INT", "screenrecord"],
    ["shell", "killall", "-INT", "screenrecord"],
  ];

  for (const command of stopCommands) {
    const result = await adb(command, serial, { allowFailure: true, timeoutMs: 5_000 });
    const output = `${result.stdout}\n${result.stderr}`.trim().toLowerCase();
    if (result.exitCode === 0 || output.length === 0 || output.includes("no process killed")) {
      return;
    }
  }
}

export async function stopScreenRecording(
  localPath: string,
  options?: {
    serial?: string;
    remotePath?: string;
  },
): Promise<{ success: boolean; error?: string; path?: string; durationMs?: number }> {
  const key = recordingKey(options?.serial);
  const active = activeRecordings.get(key);
  if (!active) {
    return {
      success: false,
      error: "No active screen recording was found for this device/session.",
    };
  }

  await requestRemoteScreenRecordingStop(options?.serial);
  const exit = await waitForProcessExit(active.process, 3_000);
  if (!exit.exited) {
    active.process.kill("SIGTERM");
    await waitForProcessExit(active.process, 2_000);
  }

  const remotePath = options?.remotePath ?? active.remotePath;
  const pullResult = await adb(["pull", remotePath, localPath], options?.serial, {
    allowFailure: true,
    timeoutMs: 120_000,
  });
  await adb(["shell", "rm", remotePath], options?.serial, { allowFailure: true, timeoutMs: 10_000 });
  activeRecordings.delete(key);

  const output = `${pullResult.stdout}\n${pullResult.stderr}`.trim();
  if (pullResult.exitCode !== 0 || /error|failed/i.test(output)) {
    return {
      success: false,
      error: output || "Failed to pull the recorded video from the device.",
      durationMs: Date.now() - active.startedAt,
    };
  }

  return {
    success: true,
    path: localPath,
    durationMs: Date.now() - active.startedAt,
  };
}

function center(bounds: [number, number, number, number]): [number, number] {
  return [
    Math.round((bounds[0] + bounds[2]) / 2),
    Math.round((bounds[1] + bounds[3]) / 2),
  ];
}

function encodeInputText(text: string): string {
  return text
    .replace(/%/g, "%25")
    .replace(/\s/g, "%s")
    .replace(/(["'&<>|;()\\$`])/g, "\\$1");
}

async function clearFocusedField(serial?: string, existingText?: string): Promise<void> {
  const deletePresses = Math.max(existingText?.length ?? 0, 6);
  await adb(["shell", "input", "keyevent", "KEYCODE_MOVE_END"], serial, { allowFailure: true });

  for (let index = 0; index < deletePresses; index += 1) {
    await adb(["shell", "input", "keyevent", "KEYCODE_DEL"], serial, {
      allowFailure: true,
      timeoutMs: 5_000,
    });
  }
}

export async function tap(
  ref: string,
  snapshot: Snapshot,
  serial?: string,
): Promise<{ success: boolean; error?: string }> {
  const element = snapshot.elements.find((candidate) => candidate.ref === ref);
  if (!element) {
    return { success: false, error: `Element ${ref} not found in current snapshot.` };
  }

  const [x, y] = center(element.bounds);
  if (x === 0 && y === 0) {
    return { success: false, error: `Element ${ref} does not have usable bounds.` };
  }

  await adb(["shell", "input", "tap", String(x), String(y)], serial, { timeoutMs: 10_000 });
  return { success: true };
}

export async function fill(
  ref: string,
  text: string,
  snapshot: Snapshot,
  serial?: string,
): Promise<{ success: boolean; error?: string }> {
  const element = snapshot.elements.find((candidate) => candidate.ref === ref);
  if (!element) {
    return { success: false, error: `Element ${ref} not found in current snapshot.` };
  }

  const tapResult = await tap(ref, snapshot, serial);
  if (!tapResult.success) {
    return tapResult;
  }

  await new Promise((resolve) => setTimeout(resolve, 250));
  await clearFocusedField(serial, element.text);
  await new Promise((resolve) => setTimeout(resolve, 150));

  const typeResult = await adb(
    ["shell", "input", "text", encodeInputText(text)],
    serial,
    { allowFailure: true, timeoutMs: 15_000 },
  );

  if (typeResult.exitCode !== 0) {
    return {
      success: false,
      error: `${typeResult.stderr}\n${typeResult.stdout}`.trim() || "Failed to type text.",
    };
  }

  return { success: true };
}

export async function scroll(
  direction: "up" | "down" | "left" | "right",
  serial?: string,
): Promise<void> {
  const display = await getDisplaySize(serial);
  const centerX = Math.round(display.width / 2);
  const centerY = Math.round(display.height / 2);
  const horizontalStart = Math.round(display.width * 0.85);
  const horizontalEnd = Math.round(display.width * 0.15);
  const verticalStart = Math.round(display.height * 0.8);
  const verticalEnd = Math.round(display.height * 0.25);

  // `direction` follows the content/navigation intent, not the finger gesture.
  // Example: scrolling "down" should reveal lower content, which requires an upward swipe.
  const swipes: Record<typeof direction, [number, number, number, number]> = {
    up: [centerX, verticalEnd, centerX, verticalStart],
    down: [centerX, verticalStart, centerX, verticalEnd],
    left: [horizontalEnd, centerY, horizontalStart, centerY],
    right: [horizontalStart, centerY, horizontalEnd, centerY],
  };

  const [x1, y1, x2, y2] = swipes[direction];
  await adb(
    ["shell", "input", "swipe", String(x1), String(y1), String(x2), String(y2), "250"],
    serial,
    { timeoutMs: 10_000 },
  );
}

export async function pressBack(serial?: string): Promise<void> {
  await adb(["shell", "input", "keyevent", "KEYCODE_BACK"], serial, { timeoutMs: 10_000 });
}

export async function getAppLogs(
  packageName: string,
  options?: {
    maxLines?: number;
    serial?: string;
    sinceEpochMs?: number | null;
    pid?: number | null;
  },
): Promise<AppLogResult> {
  const maxLines = options?.maxLines ?? 50;
  const serial = options?.serial;
  const currentPid = options?.pid ?? await getAppPid(packageName, serial);
  const logArgs = ["shell", "logcat", "-d", "-v", "epoch"];

  if (options?.sinceEpochMs) {
    logArgs.push("-T", formatLogcatEpoch(options.sinceEpochMs));
  }

  if (currentPid !== null) {
    logArgs.push("--pid", String(currentPid));
  }

  const logResult = await adb(logArgs, serial, { allowFailure: true, timeoutMs: 20_000 });
  const entries = parseLogcatEntries(logResult.stdout);
  const lines = entries.slice(-maxLines).map((entry) => entry.raw);
  const crashes = extractCrashSummaries(entries, { packageName, pid: currentPid });

  return {
    baselineEpochMs: options?.sinceEpochMs ?? null,
    pid: currentPid,
    lines,
    entries,
    crashes,
  };
}

export async function checkHealth(
  packageName: string,
  options?: {
    serial?: string;
    pid?: number | null;
    sessionBaselineEpochMs?: number | null;
    launchBaselineEpochMs?: number | null;
  },
): Promise<{
  appRunning: boolean;
  pid: number | null;
  memoryMb: number | null;
  logsPid: number | null;
  logBaselineEpochMs: number | null;
  launchBaselineEpochMs: number | null;
  crashesSinceSession: number;
  crashesSinceLaunch: number;
}> {
  const serial = options?.serial;
  const pid = await getAppPid(packageName, serial);
  const logsPid = pid ?? options?.pid ?? null;

  let memoryMb: number | null = null;
  if (pid) {
    const meminfo = await adb(
      ["shell", "dumpsys", "meminfo", String(pid)],
      serial,
      { allowFailure: true, timeoutMs: 15_000 },
    );
    const totalMatch =
      meminfo.stdout.match(/TOTAL PSS:\s+([\d,]+)/) ??
      meminfo.stdout.match(/TOTAL\s+([\d,]+)/);
    if (totalMatch?.[1]) {
      memoryMb = Math.round(parseInt(totalMatch[1].replace(/,/g, ""), 10) / 1024);
    }
  }

  const sessionLogs = await getAppLogs(packageName, {
    maxLines: 200,
    serial,
    sinceEpochMs: options?.sessionBaselineEpochMs ?? null,
    pid: logsPid,
  });
  const launchLogs = options?.launchBaselineEpochMs
    ? await getAppLogs(packageName, {
        maxLines: 200,
        serial,
        sinceEpochMs: options.launchBaselineEpochMs,
        pid: logsPid,
      })
    : null;

  return {
    appRunning: pid !== null,
    pid,
    logsPid,
    memoryMb,
    logBaselineEpochMs: options?.sessionBaselineEpochMs ?? null,
    launchBaselineEpochMs: options?.launchBaselineEpochMs ?? null,
    crashesSinceSession: sessionLogs.crashes.length,
    crashesSinceLaunch: launchLogs?.crashes.length ?? 0,
  };
}
