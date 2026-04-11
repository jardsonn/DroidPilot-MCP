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
      text: "Continue",
      hint: undefined,
      contentDesc: "Primary CTA",
      resourceId: "com.example.app:id/continueButton",
      testTag: "continueButton",
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
      text: "Franco",
      hint: "Username",
      contentDesc: undefined,
      resourceId: "com.example.app:id/profileName",
      testTag: "profileName",
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
      text: "Profile",
      hint: undefined,
      contentDesc: "Open profile tab",
      resourceId: "com.example.app:id/tab_profile",
      testTag: "tab_profile",
      bounds: [0, 200, 100, 300],
      clickable: true,
      focusable: true,
      scrollable: false,
      enabled: true,
      editable: false,
      checked: false,
      selected: true,
    },
  ],
};

test("matchesElement supports exact and partial selector fields", () => {
  assert.equal(
    matchesElement(snapshot.elements[0], {
      text: "continue",
      resourceIdContains: "continue",
      testTag: "continuebutton",
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

test("describe helpers generate useful debug strings", () => {
  assert.match(describeElement(snapshot.elements[2]), /@e3/);
  assert.match(describeElement(snapshot.elements[2]), /resourceId="com\.example\.app:id\/tab_profile"/);
  assert.match(describeElement(snapshot.elements[2]), /testTag="tab_profile"/);
  assert.equal(
    describeQuery({ textContains: "profile", testTag: "tab_profile", selected: true }),
    'textContains="profile", testTag="tab_profile", selected=true',
  );
});
