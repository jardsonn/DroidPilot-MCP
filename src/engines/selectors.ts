import type { Snapshot, UIElement } from "./adb.js";

export interface ElementQuery {
  ref?: string;
  resourceId?: string;
  resourceIdContains?: string;
  testTag?: string;
  testTagContains?: string;
  label?: string;
  labelContains?: string;
  text?: string;
  textContains?: string;
  contentDesc?: string;
  contentDescContains?: string;
  hint?: string;
  hintContains?: string;
  parentTextContains?: string;
  childTextContains?: string;
  siblingTextContains?: string;
  contextTextContains?: string;
  nearText?: string;
  nearTextContains?: string;
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

function center(bounds: [number, number, number, number]): [number, number] {
  return [
    (bounds[0] + bounds[2]) / 2,
    (bounds[1] + bounds[3]) / 2,
  ];
}

function distanceBetween(left: UIElement, right: UIElement): number {
  const [leftX, leftY] = center(left.bounds);
  const [rightX, rightY] = center(right.bounds);
  return Math.hypot(leftX - rightX, leftY - rightY);
}

function anchorTextMatches(element: UIElement, exact?: string, contains?: string): boolean {
  const fields = [
    element.text,
    element.contentDesc,
    element.hint,
    element.label,
    element.parentText,
    element.childText,
    element.siblingText,
    element.contextText,
  ];

  if (exact !== undefined) {
    return fields.some((field) => equalsIgnoreCase(field, exact));
  }
  if (contains !== undefined) {
    return fields.some((field) => containsIgnoreCase(field, contains));
  }
  return false;
}

function proximityScore(candidate: UIElement, anchors: UIElement[]): number {
  let bestScore = Number.POSITIVE_INFINITY;

  for (const anchor of anchors) {
    let score = distanceBetween(candidate, anchor);

    if (candidate.containerPath && anchor.containerPath && candidate.containerPath === anchor.containerPath) {
      score *= 0.25;
    } else if (candidate.parentRef && anchor.parentRef && candidate.parentRef === anchor.parentRef) {
      score *= 0.45;
    }

    if (candidate.contextText && anchor.text && containsIgnoreCase(candidate.contextText, anchor.text)) {
      score *= 0.7;
    }

    if (candidate.ref === anchor.ref) {
      score += 10_000;
    }

    bestScore = Math.min(bestScore, score);
  }

  return bestScore;
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
  if (query.label !== undefined && !equalsIgnoreCase(element.label, query.label)) {
    return false;
  }
  if (query.labelContains !== undefined && !containsIgnoreCase(element.label, query.labelContains)) {
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
  if (query.parentTextContains !== undefined && !containsIgnoreCase(element.parentText, query.parentTextContains)) {
    return false;
  }
  if (query.childTextContains !== undefined && !containsIgnoreCase(element.childText, query.childTextContains)) {
    return false;
  }
  if (query.siblingTextContains !== undefined && !containsIgnoreCase(element.siblingText, query.siblingTextContains)) {
    return false;
  }
  if (query.contextTextContains !== undefined && !containsIgnoreCase(element.contextText, query.contextTextContains)) {
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
  const matches = snapshot.elements.filter((element) => matchesElement(element, query));
  const hasNearConstraint = query.nearText !== undefined || query.nearTextContains !== undefined;
  if (!hasNearConstraint) {
    return matches;
  }

  const anchors = snapshot.elements.filter((element) =>
    anchorTextMatches(element, query.nearText, query.nearTextContains),
  );
  if (anchors.length === 0) {
    return [];
  }

  return [...matches].sort((left, right) => proximityScore(left, anchors) - proximityScore(right, anchors));
}

export function describeElement(element: UIElement): string {
  const parts = [
    element.ref,
    element.type,
    element.text ? `text="${element.text}"` : null,
    !element.text && element.label ? `label="${element.label}"` : null,
    element.contentDesc ? `contentDesc="${element.contentDesc}"` : null,
    element.resourceId ? `resourceId="${element.resourceId}"` : null,
    element.testTag ? `testTag="${element.testTag}"` : null,
    !element.text && element.contextText ? `context="${element.contextText}"` : null,
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
