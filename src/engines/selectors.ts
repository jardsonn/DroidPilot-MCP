import type { Snapshot, UIElement } from "./adb.js";

export interface ElementQuery {
  ref?: string;
  resourceId?: string;
  resourceIdContains?: string;
  testTag?: string;
  testTagContains?: string;
  text?: string;
  textContains?: string;
  contentDesc?: string;
  contentDescContains?: string;
  hint?: string;
  hintContains?: string;
  type?: string;
  clickable?: boolean;
  focusable?: boolean;
  scrollable?: boolean;
  editable?: boolean;
  enabled?: boolean;
  checked?: boolean;
  selected?: boolean;
}

function equalsIgnoreCase(left: string | undefined, right: string | undefined): boolean {
  return (left ?? "").toLowerCase() === (right ?? "").toLowerCase();
}

function containsIgnoreCase(haystack: string | undefined, needle: string | undefined): boolean {
  return (haystack ?? "").toLowerCase().includes((needle ?? "").toLowerCase());
}

export function matchesElement(element: UIElement, query: ElementQuery): boolean {
  if (query.ref !== undefined && element.ref !== query.ref) {
    return false;
  }
  if (query.resourceId !== undefined && !equalsIgnoreCase(element.resourceId, query.resourceId)) {
    return false;
  }
  if (query.resourceIdContains !== undefined && !containsIgnoreCase(element.resourceId, query.resourceIdContains)) {
    return false;
  }
  if (query.testTag !== undefined && !equalsIgnoreCase(element.testTag, query.testTag)) {
    return false;
  }
  if (query.testTagContains !== undefined && !containsIgnoreCase(element.testTag, query.testTagContains)) {
    return false;
  }
  if (query.text !== undefined && !equalsIgnoreCase(element.text, query.text)) {
    return false;
  }
  if (query.textContains !== undefined && !containsIgnoreCase(element.text, query.textContains)) {
    return false;
  }
  if (query.contentDesc !== undefined && !equalsIgnoreCase(element.contentDesc, query.contentDesc)) {
    return false;
  }
  if (
    query.contentDescContains !== undefined &&
    !containsIgnoreCase(element.contentDesc, query.contentDescContains)
  ) {
    return false;
  }
  if (query.hint !== undefined && !equalsIgnoreCase(element.hint, query.hint)) {
    return false;
  }
  if (query.hintContains !== undefined && !containsIgnoreCase(element.hint, query.hintContains)) {
    return false;
  }
  if (query.type !== undefined && !equalsIgnoreCase(element.type, query.type)) {
    return false;
  }
  if (query.clickable !== undefined && element.clickable !== query.clickable) {
    return false;
  }
  if (query.focusable !== undefined && element.focusable !== query.focusable) {
    return false;
  }
  if (query.scrollable !== undefined && element.scrollable !== query.scrollable) {
    return false;
  }
  if (query.editable !== undefined && element.editable !== query.editable) {
    return false;
  }
  if (query.enabled !== undefined && element.enabled !== query.enabled) {
    return false;
  }
  if (query.checked !== undefined && element.checked !== query.checked) {
    return false;
  }
  if (query.selected !== undefined && element.selected !== query.selected) {
    return false;
  }

  return true;
}

export function findMatchingElements(snapshot: Snapshot, query: ElementQuery): UIElement[] {
  return snapshot.elements.filter((element) => matchesElement(element, query));
}

export function describeElement(element: UIElement): string {
  const parts = [
    element.ref,
    element.type,
    element.text ? `text="${element.text}"` : null,
    element.contentDesc ? `contentDesc="${element.contentDesc}"` : null,
    element.resourceId ? `resourceId="${element.resourceId}"` : null,
    element.testTag ? `testTag="${element.testTag}"` : null,
    element.selected ? "selected=true" : null,
  ].filter(Boolean);

  return parts.join(" ");
}

export function describeQuery(query: ElementQuery): string {
  const parts = Object.entries(query)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`);

  return parts.length > 0 ? parts.join(", ") : "empty query";
}
