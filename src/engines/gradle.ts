/**
 * Build Engine - Gradle wrapper for Android projects
 *
 * Detects project structure, runs builds, parses Kotlin/Java/AAPT
 * errors into structured JSON, and discovers APK/package metadata.
 */

import { execFile } from "node:child_process";
import { access, constants, readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const exec = promisify(execFile);

const DEFAULT_BUILD_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_MAX_BUFFER = 20 * 1024 * 1024;

export class GradleError extends Error {
  constructor(
    public readonly code:
      | "PROJECT_NOT_FOUND"
      | "GRADLE_WRAPPER_NOT_FOUND"
      | "GRADLE_COMMAND_FAILED"
      | "AAPT_NOT_FOUND",
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "GradleError";
  }
}

export interface BuildError {
  file: string;
  line: number;
  column: number;
  severity: "error" | "warning";
  message: string;
}

export interface BuildResult {
  status: "success" | "build_failed" | "project_not_found";
  apkPath?: string;
  packageName?: string;
  launchActivity?: string;
  durationMs: number;
  errors: BuildError[];
  warningsCount: number;
  incremental: boolean;
  summary?: string;
  outputTail?: string[];
}

export interface ProjectInfo {
  projectDir: string;
  rootModule: string;
  applicationId?: string;
  gradleWrapper: string;
  buildVariant: string;
}

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

function dedupe<T>(values: T[]): T[] {
  return [...new Set(values)];
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function normalizeModuleName(moduleName: string): string {
  return moduleName.replace(/^:+/, "");
}

function toGradleTask(moduleName: string, taskName: string): string {
  const normalized = normalizeModuleName(moduleName);
  return normalized ? `:${normalized}:${taskName}` : taskName;
}

function getSdkRoots(): string[] {
  const localAppData = process.env.LOCALAPPDATA;
  const userProfile = process.env.USERPROFILE;
  const home = process.env.HOME ?? userProfile;
  return dedupe(
    [
      process.env.ANDROID_SDK_ROOT,
      process.env.ANDROID_HOME,
      localAppData ? join(localAppData, "Android", "Sdk") : null,
      userProfile ? join(userProfile, "AppData", "Local", "Android", "Sdk") : null,
      home ? join(home, "Android", "Sdk") : null,
    ].filter((value): value is string => Boolean(value?.trim())),
  );
}

async function resolveAaptPath(): Promise<string | null> {
  const binary = process.platform === "win32" ? "aapt.exe" : "aapt";
  for (const sdkRoot of getSdkRoots()) {
    const buildToolsDir = join(sdkRoot, "build-tools");
    if (!(await fileExists(buildToolsDir))) {
      continue;
    }

    const entries = await readdir(buildToolsDir, { withFileTypes: true });
    const versions = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));

    for (const version of versions) {
      const candidate = join(buildToolsDir, version, binary);
      if (await fileExists(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

async function runCommand(
  command: string,
  args: string[],
  options: {
    cwd: string;
    timeoutMs?: number;
    allowFailure?: boolean;
    env?: Record<string, string | undefined>;
  },
): Promise<CommandResult> {
  const env = {
    ...process.env,
    ...options.env,
  };

  const invocation =
    process.platform === "win32" && command.toLowerCase().endsWith(".bat")
      ? {
          file: "cmd.exe",
          args: ["/d", "/s", "/c", command, ...args],
        }
      : {
          file: command,
          args,
        };

  try {
    const result = await exec(invocation.file, invocation.args, {
      cwd: options.cwd,
      timeout: options.timeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS,
      maxBuffer: DEFAULT_MAX_BUFFER,
      env,
    });

    return {
      stdout: result.stdout,
      stderr: result.stderr ?? "",
      exitCode: 0,
    };
  } catch (error: any) {
    const result: CommandResult = {
      stdout: error?.stdout ?? "",
      stderr: error?.stderr ?? error?.message ?? "Unknown process failure",
      exitCode: typeof error?.code === "number" ? error.code : null,
    };

    if (options.allowFailure) {
      return result;
    }

    throw new GradleError(
      "GRADLE_COMMAND_FAILED",
      `Command failed: ${command} ${args.join(" ")}`.trim(),
      result,
    );
  }
}

function extractApplicationIdFromBuildFile(content: string): string | undefined {
  const patterns = [
    /applicationId\s*=\s*["']([^"']+)["']/,
    /applicationId\s+["']([^"']+)["']/,
  ];

  for (const pattern of patterns) {
    const match = content.match(pattern);
    if (match?.[1]) {
      return match[1];
    }
  }

  return undefined;
}

async function resolveBuildFile(projectDir: string, moduleName: string): Promise<string | null> {
  const normalized = normalizeModuleName(moduleName);
  const kotlinPath = join(projectDir, normalized, "build.gradle.kts");
  if (await fileExists(kotlinPath)) {
    return kotlinPath;
  }

  const groovyPath = join(projectDir, normalized, "build.gradle");
  if (await fileExists(groovyPath)) {
    return groovyPath;
  }

  return null;
}

async function resolveGradleWrapper(projectDir: string): Promise<string | null> {
  const candidates =
    process.platform === "win32"
      ? [join(projectDir, "gradlew.bat"), join(projectDir, "gradlew")]
      : [join(projectDir, "gradlew"), join(projectDir, "gradlew.bat")];

  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      return candidate;
    }
  }

  return null;
}

export async function detectProject(dir: string): Promise<ProjectInfo | null> {
  const projectDir = resolve(dir);
  const hasSettings =
    (await fileExists(join(projectDir, "settings.gradle"))) ||
    (await fileExists(join(projectDir, "settings.gradle.kts")));

  if (!hasSettings) {
    return null;
  }

  const gradleWrapper = await resolveGradleWrapper(projectDir);
  if (!gradleWrapper) {
    return null;
  }

  let rootModule = "app";
  const defaultAppBuildFile = await resolveBuildFile(projectDir, rootModule);
  if (!defaultAppBuildFile) {
    const entries = await readdir(projectDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) {
        continue;
      }

      const candidate = await resolveBuildFile(projectDir, entry.name);
      if (!candidate) {
        continue;
      }

      const content = await readFile(candidate, "utf-8");
      if (/com\.android\.application/.test(content)) {
        rootModule = entry.name;
        break;
      }
    }
  }

  const buildFile = await resolveBuildFile(projectDir, rootModule);
  const applicationId =
    buildFile ? extractApplicationIdFromBuildFile(await readFile(buildFile, "utf-8")) : undefined;

  return {
    projectDir,
    rootModule,
    applicationId,
    gradleWrapper,
    buildVariant: "debug",
  };
}

function extractLines(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean);
}

function addBuildError(
  target: BuildError[],
  file: string,
  line: string | number | undefined,
  column: string | number | undefined,
  severity: "error" | "warning",
  message: string | undefined,
): void {
  const cleanMessage = message?.trim();
  if (!cleanMessage) {
    return;
  }

  const normalizedFile = file.replace(/^\/([A-Za-z]:[\\/])/, "$1");

  target.push({
    file: normalizedFile,
    line: Number(line ?? 0),
    column: Number(column ?? 0),
    severity,
    message: cleanMessage,
  });
}

function parseErrors(output: string): BuildError[] {
  const errors: BuildError[] = [];
  let match: RegExpExecArray | null;

  const patterns: Array<{ regex: RegExp; map: (parts: RegExpExecArray) => void }> = [
    {
      regex: /^[ew]:\s+(?:file:\/\/)?(.+?\.(?:kt|kts|java|xml)):(\d+):(\d+)\s+(.*)$/gm,
      map: (parts) => addBuildError(errors, parts[1], parts[2], parts[3], "error", parts[4]),
    },
    {
      regex: /^[ew]:\s+(?:file:\/\/)?(.+?\.(?:kt|kts|java|xml)):\s+\((\d+),\s*(\d+)\):\s+(.*)$/gm,
      map: (parts) => addBuildError(errors, parts[1], parts[2], parts[3], "error", parts[4]),
    },
    {
      regex: /^(.+?\.(?:java|kt|kts|xml)):(\d+):(?:(\d+):)?\s+error:\s+(.*)$/gm,
      map: (parts) => addBuildError(errors, parts[1], parts[2], parts[3], "error", parts[4]),
    },
    {
      regex: /\[kapt\]\s+.*?(\S+\.kt):(\d+):\s+(.*)$/gm,
      map: (parts) => addBuildError(errors, parts[1], parts[2], 0, "error", parts[3]),
    },
    {
      regex: /^(.+?\.xml):(\d+):\s+AAPT:\s+error:\s+(.*)$/gm,
      map: (parts) => addBuildError(errors, parts[1], parts[2], 0, "error", parts[3]),
    },
    {
      regex: /^AAPT:\s+error:\s+(.*)$/gm,
      map: (parts) => addBuildError(errors, "resources", 0, 0, "error", parts[1]),
    },
  ];

  for (const pattern of patterns) {
    while ((match = pattern.regex.exec(output)) !== null) {
      pattern.map(match);
    }
  }

  if (errors.length === 0 && output.includes("BUILD FAILED")) {
    const taskFailure = output.match(/Execution failed for task '([^']+)'\.[\s\S]*?>\s*(.+)/);
    if (taskFailure?.[1] && taskFailure?.[2]) {
      addBuildError(
        errors,
        "build.gradle",
        0,
        0,
        "error",
        `Task ${taskFailure[1]} failed: ${taskFailure[2].split(/\r?\n/)[0]}`,
      );
    }
  }

  const unique = new Map<string, BuildError>();
  for (const error of errors) {
    unique.set(`${error.file}:${error.line}:${error.column}:${error.message}`, error);
  }
  return [...unique.values()];
}

function parseWarnings(output: string): BuildError[] {
  const warnings: BuildError[] = [];
  let match: RegExpExecArray | null;

  const patterns: Array<{ regex: RegExp; map: (parts: RegExpExecArray) => void }> = [
    {
      regex: /^w:\s+(?:file:\/\/)?(.+?\.(?:kt|kts|java|xml)):(\d+):(\d+)\s+(.*)$/gm,
      map: (parts) => addBuildError(warnings, parts[1], parts[2], parts[3], "warning", parts[4]),
    },
    {
      regex: /^(.+?\.(?:java|kt|kts|xml)):(\d+):(?:(\d+):)?\s+warning:\s+(.*)$/gm,
      map: (parts) => addBuildError(warnings, parts[1], parts[2], parts[3], "warning", parts[4]),
    },
  ];

  for (const pattern of patterns) {
    while ((match = pattern.regex.exec(output)) !== null) {
      pattern.map(match);
    }
  }

  return warnings;
}

function summarizeFailure(output: string): string | undefined {
  const lines = extractLines(output);
  const preferredLine = lines.find((line) =>
    /Execution failed|BUILD FAILED|error:|Exception|AAPT: error/i.test(line),
  );
  return preferredLine ?? lines.at(-1);
}

async function collectFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectFiles(fullPath));
    } else {
      files.push(fullPath);
    }
  }

  return files;
}

async function findApk(project: ProjectInfo): Promise<string | null> {
  const apkRoot = join(
    project.projectDir,
    normalizeModuleName(project.rootModule),
    "build",
    "outputs",
    "apk",
  );

  if (!(await fileExists(apkRoot))) {
    return null;
  }

  const files = await collectFiles(apkRoot);
  const candidates = await Promise.all(
    files
      .filter((file) => file.endsWith(".apk"))
      .filter((file) => !/androidTest|unaligned/i.test(file))
      .map(async (file) => ({
        file,
        stat: await stat(file),
        score:
          (file.toLowerCase().includes(project.buildVariant.toLowerCase()) ? 20 : 0) +
          (file.toLowerCase().includes("debug") ? 10 : 0) +
          (!file.toLowerCase().includes("unsigned") ? 2 : 0),
      })),
  );

  candidates.sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    return right.stat.mtimeMs - left.stat.mtimeMs;
  });

  return candidates[0]?.file ?? null;
}

function normalizeLaunchActivity(packageName: string, activityName: string | undefined): string | undefined {
  if (!activityName) {
    return undefined;
  }

  if (activityName.includes("/")) {
    return activityName;
  }

  if (activityName.startsWith(".")) {
    return `${packageName}/${activityName}`;
  }

  if (activityName.startsWith(packageName)) {
    return `${packageName}/${activityName}`;
  }

  return `${packageName}/.${activityName}`;
}

async function readApkMetadata(apkPath: string): Promise<{
  packageName?: string;
  launchActivity?: string;
}> {
  const aaptPath = await resolveAaptPath();
  if (!aaptPath) {
    return {};
  }

  const result = await runCommand(aaptPath, ["dump", "badging", apkPath], {
    cwd: dirname(apkPath),
    allowFailure: true,
    timeoutMs: 20_000,
  });

  const output = `${result.stdout}\n${result.stderr}`;
  const packageName = output.match(/package:\s+name='([^']+)'/)?.[1];
  const launchableActivityName = output.match(/launchable-activity:\s+name='([^']+)'/)?.[1];

  return {
    packageName,
    launchActivity: packageName
      ? normalizeLaunchActivity(packageName, launchableActivityName)
      : undefined,
  };
}

export async function buildProject(
  project: ProjectInfo,
  clean: boolean = false,
): Promise<BuildResult> {
  const startTime = Date.now();
  const tasks = clean
    ? ["clean", toGradleTask(project.rootModule, "assembleDebug")]
    : [toGradleTask(project.rootModule, "assembleDebug")];

  const gradleArgs = [
    ...tasks,
    "--console=plain",
    "--daemon",
    "--parallel",
    "--build-cache",
  ];

  const env = {
    JAVA_HOME: process.env.JAVA_HOME,
    ANDROID_HOME: process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT,
    ANDROID_SDK_ROOT: process.env.ANDROID_SDK_ROOT ?? process.env.ANDROID_HOME,
  };

  const result = await runCommand(project.gradleWrapper, gradleArgs, {
    cwd: project.projectDir,
    allowFailure: true,
    timeoutMs: DEFAULT_BUILD_TIMEOUT_MS,
    env,
  });

  const durationMs = Date.now() - startTime;
  const combinedOutput = `${result.stdout}\n${result.stderr}`.trim();
  const warnings = parseWarnings(combinedOutput);

  if (result.exitCode === 0) {
    const apkPath = await findApk(project);
    const apkMetadata = apkPath ? await readApkMetadata(apkPath) : {};

    return {
      status: "success",
      apkPath: apkPath ?? undefined,
      packageName: apkMetadata.packageName ?? project.applicationId,
      launchActivity: apkMetadata.launchActivity,
      durationMs,
      errors: [],
      warningsCount: warnings.length,
      incremental: !clean,
      summary: apkPath ? "Build completed successfully." : "Build completed, but no APK was discovered.",
      outputTail: extractLines(combinedOutput).slice(-20),
    };
  }

  const errors = parseErrors(combinedOutput);

  return {
    status: "build_failed",
    durationMs,
    errors,
    warningsCount: warnings.length,
    incremental: !clean,
    summary: summarizeFailure(combinedOutput),
    outputTail: extractLines(combinedOutput).slice(-40),
  };
}

export { extractApplicationIdFromBuildFile };
