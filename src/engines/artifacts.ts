import { mkdir, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type ArtifactKind = "snapshots" | "screenshots" | "diffs" | "videos";

export async function createSessionArtifactsDir(sessionId: string, baseDir?: string): Promise<string> {
  const rootDir = baseDir ?? join(tmpdir(), "droidpilot-artifacts");
  const sessionDir = join(rootDir, sessionId);
  await mkdir(sessionDir, { recursive: true });
  return sessionDir;
}

export async function ensureArtifactSubdir(artifactsDir: string, kind: ArtifactKind): Promise<string> {
  const path = join(artifactsDir, kind);
  await mkdir(path, { recursive: true });
  return path;
}

function padSequence(sequence: number): string {
  return sequence.toString().padStart(3, "0");
}

export async function nextArtifactPath(
  artifactsDir: string,
  kind: ArtifactKind,
  sequence: number,
  extension: string,
): Promise<string> {
  const dir = await ensureArtifactSubdir(artifactsDir, kind);
  const normalizedExtension = extension.startsWith(".") ? extension : `.${extension}`;
  const basename = kind.slice(0, -1);
  return join(dir, `${basename}-${padSequence(sequence)}${normalizedExtension}`);
}

export async function writeJsonArtifact(
  artifactsDir: string,
  kind: Extract<ArtifactKind, "snapshots" | "diffs">,
  sequence: number,
  payload: unknown,
): Promise<string> {
  const path = await nextArtifactPath(artifactsDir, kind, sequence, ".json");
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return path;
}

export async function listArtifacts(artifactsDir: string): Promise<Record<ArtifactKind, string[]>> {
  const result: Record<ArtifactKind, string[]> = {
    snapshots: [],
    screenshots: [],
    diffs: [],
    videos: [],
  };

  await Promise.all(
    (Object.keys(result) as ArtifactKind[]).map(async (kind) => {
      try {
        const dir = await ensureArtifactSubdir(artifactsDir, kind);
        result[kind] = await readdir(dir);
      } catch {
        result[kind] = [];
      }
    }),
  );

  return result;
}
