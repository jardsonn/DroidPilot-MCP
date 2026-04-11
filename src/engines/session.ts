/**
 * Session Manager — Maintains state across MCP tool calls
 *
 * Tracks the active project, device, package, and latest snapshot
 * so tools don't need to repeat configuration every call.
 */

import type { ProjectInfo } from "./gradle.js";
import type { Snapshot, Device } from "./adb.js";

export interface Session {
  id: string;
  project: ProjectInfo | null;
  device: Device | null;
  packageName: string | null;
  lastSnapshot: Snapshot | null;
  previousSnapshot: Snapshot | null;
  logBaselineEpochMs: number;
  launchBaselineEpochMs: number | null;
  lastKnownPid: number | null;
  startedAt: number;
}

let activeSession: Session | null = null;

export function createSession(): Session {
  const now = Date.now();
  activeSession = {
    id: `s${now}`,
    project: null,
    device: null,
    packageName: null,
    lastSnapshot: null,
    previousSnapshot: null,
    logBaselineEpochMs: now,
    launchBaselineEpochMs: null,
    lastKnownPid: null,
    startedAt: now,
  };
  return activeSession;
}

export function getSession(): Session | null {
  return activeSession;
}

export function requireSession(): Session {
  if (!activeSession) {
    throw new Error(
      "No active session. Call the 'open' tool first with your project directory.",
    );
  }
  return activeSession;
}

export function updateSession(updates: Partial<Session>): Session {
  const session = requireSession();
  Object.assign(session, updates);
  return session;
}

export function setSessionSnapshot(snapshot: Snapshot): Session {
  const session = requireSession();
  session.previousSnapshot = session.lastSnapshot;
  session.lastSnapshot = snapshot;
  return session;
}

export function closeSession(): { durationS: number } {
  if (!activeSession) {
    return { durationS: 0 };
  }
  const durationS = Math.round((Date.now() - activeSession.startedAt) / 1000);
  activeSession = null;
  return { durationS };
}
