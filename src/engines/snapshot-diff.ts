import type { Snapshot, UIElement } from "./adb.js";
import { describeElement } from "./selectors.js";

export interface SnapshotDiffElementSummary {
  ref: string;
  type: string;
  text?: string;
  hint?: string;
  contentDesc?: string;
  resourceId?: string;
  testTag?: string;
  clickable: boolean;
  editable: boolean;
  enabled: boolean;
  selected: boolean;
  description: string;
}

export interface ChangedElementDiff {
  identity: string;
  before: SnapshotDiffElementSummary;
  after: SnapshotDiffElementSummary;
  changedFields: string[];
}

export interface SnapshotDiffResult {
  status: "changed" | "unchanged";
  from: {
    screen: string;
    package: string;
    elementCount: number;
    timestamp: number;
  };
  to: {
    screen: string;
    package: string;
    elementCount: number;
    timestamp: number;
  };
  screenChanged: boolean;
  packageChanged: boolean;
  addedCount: number;
  removedCount: number;
  changedCount: number;
  addedElements: SnapshotDiffElementSummary[];
  removedElements: SnapshotDiffElementSummary[];
  changedElements: ChangedElementDiff[];
  summary: string;
}

function normalize(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function summarizeElement(element: UIElement): SnapshotDiffElementSummary {
  return {
    ref: element.ref,
    type: element.type,
    text: element.text,
    hint: element.hint,
    contentDesc: element.contentDesc,
    resourceId: element.resourceId,
    testTag: element.testTag,
    clickable: element.clickable,
    editable: element.editable,
    enabled: element.enabled,
    selected: element.selected,
    description: describeElement(element),
  };
}

function elementIdentity(element: UIElement): string {
  const typedId = [
    element.resourceId ? `resource:${normalize(element.resourceId)}` : null,
    element.testTag ? `testTag:${normalize(element.testTag)}` : null,
    `type:${normalize(element.type)}`,
  ].filter(Boolean);

  if (typedId.length > 1 || normalize(element.resourceId).length > 0) {
    return typedId.join("|");
  }

  if (element.contentDesc) {
    return `content:${normalize(element.type)}|${normalize(element.contentDesc)}`;
  }
  if (element.text) {
    return `text:${normalize(element.type)}|${normalize(element.text)}`;
  }
  if (element.hint) {
    return `hint:${normalize(element.type)}|${normalize(element.hint)}`;
  }

  return `bounds:${normalize(element.type)}|${element.bounds.join(",")}`;
}

function elementSecondaryKey(element: UIElement): string {
  return [
    normalize(element.text),
    normalize(element.contentDesc),
    normalize(element.hint),
    normalize(element.resourceId),
    normalize(element.testTag),
    element.bounds.join(","),
  ].join("|");
}

function groupByIdentity(elements: UIElement[]): Map<string, UIElement[]> {
  const grouped = new Map<string, UIElement[]>();

  for (const element of elements) {
    const identity = elementIdentity(element);
    const list = grouped.get(identity) ?? [];
    list.push(element);
    grouped.set(identity, list);
  }

  for (const [identity, list] of grouped.entries()) {
    grouped.set(identity, [...list].sort((left, right) => elementSecondaryKey(left).localeCompare(elementSecondaryKey(right))));
  }

  return grouped;
}

function diffElementFields(before: UIElement, after: UIElement): string[] {
  const fields: Array<keyof UIElement> = [
    "type",
    "text",
    "hint",
    "contentDesc",
    "resourceId",
    "testTag",
    "clickable",
    "focusable",
    "scrollable",
    "editable",
    "enabled",
    "checked",
    "selected",
  ];

  const changed = fields.filter((field) => before[field] !== after[field]);
  if (before.bounds.join(",") !== after.bounds.join(",")) {
    changed.push("bounds");
  }

  return changed;
}

export function compareSnapshots(before: Snapshot, after: Snapshot): SnapshotDiffResult {
  const beforeGroups = groupByIdentity(before.elements);
  const afterGroups = groupByIdentity(after.elements);
  const identities = [...new Set([...beforeGroups.keys(), ...afterGroups.keys()])];

  const addedElements: SnapshotDiffElementSummary[] = [];
  const removedElements: SnapshotDiffElementSummary[] = [];
  const changedElements: ChangedElementDiff[] = [];

  for (const identity of identities) {
    const beforeList = beforeGroups.get(identity) ?? [];
    const afterList = afterGroups.get(identity) ?? [];
    const sharedCount = Math.min(beforeList.length, afterList.length);

    for (let index = 0; index < sharedCount; index += 1) {
      const changedFields = diffElementFields(beforeList[index], afterList[index]);
      if (changedFields.length > 0) {
        changedElements.push({
          identity,
          before: summarizeElement(beforeList[index]),
          after: summarizeElement(afterList[index]),
          changedFields,
        });
      }
    }

    if (afterList.length > beforeList.length) {
      for (const added of afterList.slice(sharedCount)) {
        addedElements.push(summarizeElement(added));
      }
    }

    if (beforeList.length > afterList.length) {
      for (const removed of beforeList.slice(sharedCount)) {
        removedElements.push(summarizeElement(removed));
      }
    }
  }

  const screenChanged = before.screen !== after.screen;
  const packageChanged = before.packageName !== after.packageName;
  const status =
    screenChanged || packageChanged || addedElements.length > 0 || removedElements.length > 0 || changedElements.length > 0
      ? "changed"
      : "unchanged";

  const summaryParts = [];
  if (screenChanged) {
    summaryParts.push(`screen changed from ${before.screen} to ${after.screen}`);
  }
  if (packageChanged) {
    summaryParts.push(`package changed from ${before.packageName} to ${after.packageName}`);
  }
  if (addedElements.length > 0) {
    summaryParts.push(`${addedElements.length} element(s) added`);
  }
  if (removedElements.length > 0) {
    summaryParts.push(`${removedElements.length} element(s) removed`);
  }
  if (changedElements.length > 0) {
    summaryParts.push(`${changedElements.length} element(s) changed`);
  }

  return {
    status,
    from: {
      screen: before.screen,
      package: before.packageName,
      elementCount: before.elements.length,
      timestamp: before.timestamp,
    },
    to: {
      screen: after.screen,
      package: after.packageName,
      elementCount: after.elements.length,
      timestamp: after.timestamp,
    },
    screenChanged,
    packageChanged,
    addedCount: addedElements.length,
    removedCount: removedElements.length,
    changedCount: changedElements.length,
    addedElements,
    removedElements,
    changedElements,
    summary: summaryParts.join("; ") || "No meaningful UI changes detected.",
  };
}
