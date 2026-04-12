import test from "node:test";
import assert from "node:assert/strict";

import {
  compareSnapshots,
  evaluateSnapshotStability,
  snapshotFingerprint,
} from "../build/engines/snapshot-diff.js";

test("compareSnapshots detects screen changes and element additions/removals/updates", () => {
  const before = {
    screen: "com.example.app/.HomeActivity",
    packageName: "com.example.app",
    timestamp: 1,
    elements: [
      {
        ref: "@e1",
        type: "TextView",
        text: "Home",
        hint: undefined,
        contentDesc: undefined,
        resourceId: "com.example.app:id/title",
        testTag: "title",
        bounds: [0, 0, 100, 40],
        clickable: false,
        focusable: false,
        scrollable: false,
        enabled: true,
        editable: false,
        checked: false,
        selected: false,
      },
      {
        ref: "@e2",
        type: "NavigationBarItemView",
        text: "Profile",
        hint: undefined,
        contentDesc: "Open profile",
        resourceId: "com.example.app:id/tab_profile",
        testTag: "tab_profile",
        bounds: [0, 100, 100, 140],
        clickable: true,
        focusable: true,
        scrollable: false,
        enabled: true,
        editable: false,
        checked: false,
        selected: false,
      },
    ],
  };

  const after = {
    screen: "com.example.app/.ProfileActivity",
    packageName: "com.example.app",
    timestamp: 2,
    elements: [
      {
        ref: "@e1",
        type: "TextView",
        text: "Profile",
        hint: undefined,
        contentDesc: undefined,
        resourceId: "com.example.app:id/title",
        testTag: "title",
        bounds: [0, 0, 120, 40],
        clickable: false,
        focusable: false,
        scrollable: false,
        enabled: true,
        editable: false,
        checked: false,
        selected: false,
      },
      {
        ref: "@e2",
        type: "NavigationBarItemView",
        text: "Profile",
        hint: undefined,
        contentDesc: "Open profile",
        resourceId: "com.example.app:id/tab_profile",
        testTag: "tab_profile",
        bounds: [0, 100, 100, 140],
        clickable: true,
        focusable: true,
        scrollable: false,
        enabled: true,
        editable: false,
        checked: false,
        selected: true,
      },
      {
        ref: "@e3",
        type: "TextView",
        text: "@franco",
        hint: undefined,
        contentDesc: undefined,
        resourceId: "com.example.app:id/username",
        testTag: "username",
        bounds: [0, 160, 100, 200],
        clickable: false,
        focusable: false,
        scrollable: false,
        enabled: true,
        editable: false,
        checked: false,
        selected: false,
      },
    ],
  };

  const diff = compareSnapshots(before, after);

  assert.equal(diff.status, "changed");
  assert.equal(diff.screenChanged, true);
  assert.equal(diff.packageChanged, false);
  assert.equal(diff.addedCount, 1);
  assert.equal(diff.removedCount, 0);
  assert.equal(diff.changedCount, 2);
  assert.match(diff.summary, /screen changed/i);
  assert.match(diff.summary, /1 element\(s\) added/i);
  assert.equal(diff.addedElements[0].testTag, "username");
  assert.deepEqual(diff.changedElements[0].changedFields.length > 0, true);
});

test("compareSnapshots reports unchanged when the UI is stable", () => {
  const snapshot = {
    screen: "com.example.app/.MainActivity",
    packageName: "com.example.app",
    timestamp: 1,
    elements: [
      {
        ref: "@e1",
        type: "Button",
        text: "Continue",
        hint: undefined,
        contentDesc: "Continue",
        resourceId: "com.example.app:id/continue",
        testTag: "continue",
        bounds: [0, 0, 100, 50],
        clickable: true,
        focusable: true,
        scrollable: false,
        enabled: true,
        editable: false,
        checked: false,
        selected: false,
      },
    ],
  };

  const diff = compareSnapshots(snapshot, {
    ...snapshot,
    timestamp: 2,
    elements: [{ ...snapshot.elements[0], ref: "@e9" }],
  });

  assert.equal(diff.status, "unchanged");
  assert.equal(diff.changedCount, 0);
  assert.equal(diff.addedCount, 0);
  assert.equal(diff.removedCount, 0);
});

test("snapshotFingerprint stays stable across ref renumbering", () => {
  const base = {
    screen: "com.example.app/.MainActivity",
    packageName: "com.example.app",
    timestamp: 1,
    elements: [
      {
        ref: "@e1",
        type: "TextView",
        text: "Hello",
        hint: undefined,
        contentDesc: undefined,
        resourceId: "com.example.app:id/title",
        testTag: "title",
        bounds: [0, 0, 100, 20],
        clickable: false,
        focusable: false,
        scrollable: false,
        enabled: true,
        editable: false,
        checked: false,
        selected: false,
      },
    ],
  };

  const renumbered = {
    ...base,
    timestamp: 2,
    elements: [{ ...base.elements[0], ref: "@e9" }],
  };

  assert.equal(snapshotFingerprint(base), snapshotFingerprint(renumbered));
});

test("evaluateSnapshotStability ignores text-only churn by default", () => {
  const before = {
    screen: "com.example.app/.MainActivity",
    packageName: "com.example.app",
    timestamp: 1,
    elements: [
      {
        ref: "@e1",
        type: "TextView",
        label: "00:15",
        text: "00:15",
        hint: undefined,
        contentDesc: undefined,
        resourceId: "com.example.app:id/timer",
        testTag: "timer",
        parentText: undefined,
        childText: undefined,
        siblingText: undefined,
        contextText: "00:15",
        bounds: [0, 0, 80, 20],
        clickable: false,
        focusable: false,
        scrollable: false,
        enabled: true,
        editable: false,
        checked: false,
        selected: false,
      },
    ],
  };

  const after = {
    ...before,
    timestamp: 2,
    elements: [
      {
        ...before.elements[0],
        label: "00:14",
        text: "00:14",
        contextText: "00:14",
      },
    ],
  };

  const stability = evaluateSnapshotStability(before, after);

  assert.equal(stability.stable, true);
  assert.equal(stability.relevantChangedCount, 0);
  assert.equal(stability.ignoredChangedCount, 1);
});
