import test from "node:test";
import assert from "node:assert/strict";

import {
  describeElement,
  describeQuery,
  findMatchingElements,
  matchesElement,
} from "../build/engines/selectors.js";

const snapshot = {
  screen: "com.example.app/.MainActivity",
  packageName: "com.example.app",
  timestamp: Date.now(),
  elements: [
    {
      ref: "@e1",
      type: "Button",
      label: "Continue",
      text: "Continue",
      hint: undefined,
      contentDesc: "Primary CTA",
      resourceId: "com.example.app:id/continueButton",
      testTag: "continueButton",
      parentRef: undefined,
      containerPath: "0.0",
      depth: 1,
      parentText: undefined,
      childText: undefined,
      siblingText: "Franco | Profile",
      contextText: "Continue | Franco | Profile",
      bounds: [0, 0, 100, 100],
      clickable: true,
      focusable: true,
      scrollable: false,
      enabled: true,
      editable: false,
      checked: false,
      selected: false,
    },
    {
      ref: "@e2",
      type: "EditText",
      label: "Franco",
      text: "Franco",
      hint: "Username",
      contentDesc: undefined,
      resourceId: "com.example.app:id/profileName",
      testTag: "profileName",
      parentRef: undefined,
      containerPath: "0.0",
      depth: 1,
      parentText: undefined,
      childText: undefined,
      siblingText: "Continue | Profile",
      contextText: "Franco | Username | Continue | Profile",
      bounds: [0, 100, 100, 200],
      clickable: true,
      focusable: true,
      scrollable: false,
      enabled: true,
      editable: true,
      checked: false,
      selected: false,
    },
    {
      ref: "@e3",
      type: "NavigationBarItemView",
      label: "Profile",
      text: "Profile",
      hint: undefined,
      contentDesc: "Open profile tab",
      resourceId: "com.example.app:id/tab_profile",
      testTag: "tab_profile",
      parentRef: undefined,
      containerPath: "0.0",
      depth: 1,
      parentText: undefined,
      childText: undefined,
      siblingText: "Continue | Franco",
      contextText: "Profile | Open profile tab | Continue | Franco",
      bounds: [0, 200, 100, 300],
      clickable: true,
      focusable: true,
      scrollable: false,
      enabled: true,
      editable: false,
      checked: false,
      selected: true,
    },
    {
      ref: "@e4",
      type: "TextView",
      label: "@rafaelmendes",
      text: "@rafaelmendes",
      hint: undefined,
      contentDesc: undefined,
      resourceId: undefined,
      testTag: undefined,
      parentRef: undefined,
      containerPath: "row-1",
      depth: 2,
      parentText: "Presence list",
      childText: undefined,
      siblingText: "Registrar | Confirmar",
      contextText: "@rafaelmendes | Registrar | Confirmar | Presence list",
      bounds: [0, 320, 120, 360],
      clickable: false,
      focusable: false,
      scrollable: false,
      enabled: true,
      editable: false,
      checked: false,
      selected: false,
    },
    {
      ref: "@e5",
      type: "Button",
      label: "Registrar",
      text: "Registrar",
      hint: undefined,
      contentDesc: undefined,
      resourceId: "com.example.app:id/register",
      testTag: "register",
      parentRef: undefined,
      containerPath: "row-1",
      depth: 2,
      parentText: "Presence list",
      childText: undefined,
      siblingText: "@rafaelmendes | Confirmar",
      contextText: "Registrar | @rafaelmendes | Confirmar | Presence list",
      bounds: [220, 320, 320, 360],
      clickable: true,
      focusable: true,
      scrollable: false,
      enabled: true,
      editable: false,
      checked: false,
      selected: false,
    },
    {
      ref: "@e6",
      type: "View",
      label: "@rafaelmendes",
      text: undefined,
      hint: undefined,
      contentDesc: undefined,
      resourceId: "com.example.app:id/confirmIcon",
      testTag: "confirmIcon",
      parentRef: undefined,
      containerPath: "row-1",
      depth: 2,
      parentText: "Presence list",
      childText: undefined,
      siblingText: "@rafaelmendes | Registrar",
      contextText: "@rafaelmendes | Registrar | Presence list",
      bounds: [340, 320, 380, 360],
      clickable: true,
      focusable: true,
      scrollable: false,
      enabled: true,
      editable: false,
      checked: false,
      selected: false,
    },
    {
      ref: "@e7",
      type: "TextView",
      label: "@outro",
      text: "@outro",
      hint: undefined,
      contentDesc: undefined,
      resourceId: undefined,
      testTag: undefined,
      parentRef: undefined,
      containerPath: "row-2",
      depth: 2,
      parentText: "Presence list",
      childText: undefined,
      siblingText: "Registrar",
      contextText: "@outro | Registrar | Presence list",
      bounds: [0, 380, 120, 420],
      clickable: false,
      focusable: false,
      scrollable: false,
      enabled: true,
      editable: false,
      checked: false,
      selected: false,
    },
    {
      ref: "@e8",
      type: "Button",
      label: "Registrar",
      text: "Registrar",
      hint: undefined,
      contentDesc: undefined,
      resourceId: "com.example.app:id/register",
      testTag: "register",
      parentRef: undefined,
      containerPath: "row-2",
      depth: 2,
      parentText: "Presence list",
      childText: undefined,
      siblingText: "@outro",
      contextText: "Registrar | @outro | Presence list",
      bounds: [220, 380, 320, 420],
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

test("matchesElement supports exact and partial selector fields", () => {
  assert.equal(
    matchesElement(snapshot.elements[0], {
      text: "continue",
      resourceIdContains: "continue",
      testTag: "continuebutton",
      labelContains: "continue",
      contentDescContains: "primary",
      clickable: true,
    }),
    true,
  );

  assert.equal(
    matchesElement(snapshot.elements[0], {
      text: "cancel",
    }),
    false,
  );
});

test("findMatchingElements filters by semantic selectors and booleans", () => {
  const matches = findMatchingElements(snapshot, {
    type: "navigationbaritemview",
    selected: true,
    contentDescContains: "profile",
  });

  assert.equal(matches.length, 1);
  assert.equal(matches[0].ref, "@e3");
});

test("findMatchingElements can target editable fields by hint or resource id", () => {
  const byHint = findMatchingElements(snapshot, {
    hintContains: "user",
    editable: true,
  });
  assert.equal(byHint.length, 1);
  assert.equal(byHint[0].ref, "@e2");

  const byResourceId = findMatchingElements(snapshot, {
    resourceId: "com.example.app:id/profileName",
  });
  assert.equal(byResourceId.length, 1);
  assert.equal(byResourceId[0].ref, "@e2");

  const byTestTag = findMatchingElements(snapshot, {
    testTagContains: "profile",
    editable: true,
  });
  assert.equal(byTestTag.length, 1);
  assert.equal(byTestTag[0].ref, "@e2");
});

test("findMatchingElements supports context-aware and relational selectors", () => {
  const byContext = findMatchingElements(snapshot, {
    clickable: true,
    contextTextContains: "@rafaelmendes",
    testTagContains: "confirm",
  });
  assert.equal(byContext.length, 1);
  assert.equal(byContext[0].ref, "@e6");

  const byNearText = findMatchingElements(snapshot, {
    textContains: "Registrar",
    nearText: "@rafaelmendes",
  });
  assert.equal(byNearText.length, 2);
  assert.equal(byNearText[0].ref, "@e5");
  assert.equal(byNearText[1].ref, "@e8");

  const bySibling = findMatchingElements(snapshot, {
    clickable: true,
    siblingTextContains: "@rafaelmendes",
  });
  assert.equal(bySibling[0].ref, "@e5");
});

test("describe helpers generate useful debug strings", () => {
  assert.match(describeElement(snapshot.elements[2]), /@e3/);
  assert.match(describeElement(snapshot.elements[2]), /resourceId="com\.example\.app:id\/tab_profile"/);
  assert.match(describeElement(snapshot.elements[2]), /testTag="tab_profile"/);
  assert.match(describeElement(snapshot.elements[5]), /label="@rafaelmendes"/);
  assert.match(describeElement(snapshot.elements[5]), /context="@rafaelmendes/);
  assert.equal(
    describeQuery({ textContains: "profile", nearText: "@rafaelmendes", testTag: "tab_profile", selected: true }),
    'textContains="profile", nearText="@rafaelmendes", testTag="tab_profile", selected=true',
  );
});
