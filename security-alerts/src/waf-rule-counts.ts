import type { WafRuleBreakdown, WafRuleCount, WafRuleWindow } from './types';

const MAX_COUNT = 1_000_000_000;
const MAX_RETAINED = 32;
const MAX_DISPLAYED = 3;
const invalidDescription = /[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/;
const invalidUnicode = (value: string) => Array.from(value).some(char => {
  const code = char.codePointAt(0)!;
  return code >= 0xd800 && code <= 0xdfff;
});
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= MAX_COUNT;
function valid(value: WafRuleBreakdown | undefined, expected: number): value is WafRuleBreakdown {
  if (!value || !Array.isArray(value.rules) || value.rules.length > MAX_RETAINED ||
    Object.keys(value).some(key => !['rules','otherCount','unknownCount','limited'].includes(key)) ||
    typeof value.limited !== 'boolean' || !integer(value.otherCount) || !integer(value.unknownCount)) return false;
  const ids = new Set<string>();
  let sum = value.otherCount + value.unknownCount;
  for (const rule of value.rules) {
    if (!rule || typeof rule.ruleId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(rule.ruleId) ||
      Object.keys(rule).some(key => !['ruleId','description','count'].includes(key)) ||
      ids.has(rule.ruleId) || !integer(rule.count) || rule.count < 1 ||
      (rule.description !== undefined && (typeof rule.description !== 'string' || !rule.description.trim() ||
        rule.description.length > 160 || invalidDescription.test(rule.description) || invalidUnicode(rule.description)))) return false;
    ids.add(rule.ruleId); sum += rule.count;
  }
  return sum === expected;
}
const unknown = (count: number): WafRuleBreakdown => ({ rules: [], otherCount: 0, unknownCount: count, limited: false });

/**
 * The SQL bucket can include earlier polls or records written by an older
 * Worker. Preserve that exact count/window and classify untracked metadata as
 * unknown rather than assigning the whole bucket to the latest poll's rule.
 */
export function appendWafRuleWindow(
  previous: WafRuleWindow | undefined, start: number, previousCount: number,
  incomingCount: number, incoming: WafRuleBreakdown | undefined,
): WafRuleWindow {
  if (!integer(previousCount) || !integer(incomingCount) || !Number.isSafeInteger(start) || start < 0) throw new Error('Invalid WAF window count');
  let base = unknown(previousCount);
  if (previous?.start === start && integer(previous.count) && previous.count <= previousCount &&
    valid(previous.breakdown, previous.count)) {
    base = { ...previous.breakdown, rules: previous.breakdown.rules.map(rule => ({ ...rule })),
      unknownCount: previous.breakdown.unknownCount + previousCount - previous.count };
  }
  const count = Math.min(MAX_COUNT, previousCount + incomingCount);
  if (count < previousCount + incomingCount) {
    return { start, count, breakdown: { ...base, unknownCount: base.unknownCount + count - previousCount, limited: true } };
  }
  const extra = valid(incoming, incomingCount) ? incoming : unknown(incomingCount);
  // IDs are opaque strings; Map avoids __proto__/constructor object-key hazards.
  const rules = new Map<string, WafRuleCount>(base.rules.map(rule => [rule.ruleId, { ...rule }]));
  let otherCount = base.otherCount + extra.otherCount;
  let limited = base.limited || extra.limited;
  for (const rule of extra.rules) {
    const held = rules.get(rule.ruleId);
    if (held) {
      held.count += rule.count;
      // Keep the first observed name, filling it only when previously absent.
      if (!held.description && rule.description) held.description = rule.description;
    } else if (rules.size < MAX_RETAINED) rules.set(rule.ruleId, { ...rule });
    else { otherCount += rule.count; limited = true; }
  }
  return { start, count, breakdown: { rules: [...rules.values()], otherCount,
    unknownCount: base.unknownCount + extra.unknownCount, limited } };
}

/** Names not displayed still contribute to the exact observed total. */
export function summarizeWafRules(window: WafRuleWindow): WafRuleBreakdown {
  const ordered = [...window.breakdown.rules].sort((a, b) => b.count - a.count || a.ruleId.localeCompare(b.ruleId));
  return { rules: ordered.slice(0, MAX_DISPLAYED).map(rule => ({ ...rule })),
    otherCount: window.breakdown.otherCount + ordered.slice(MAX_DISPLAYED).reduce((sum, rule) => sum + rule.count, 0),
    unknownCount: window.breakdown.unknownCount, limited: window.breakdown.limited };
}
