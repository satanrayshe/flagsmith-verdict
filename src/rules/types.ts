import { LiveState } from '../live.js';
import { Facts } from '../scan/facts.js';

export type Severity = 'error' | 'warning' | 'info';

export interface Finding {
  ruleId: string;
  severity: Severity;
  title: string;
  /** Where the problem is: a source location, or a place in Flagsmith. */
  file: string | null;
  line: number | null;
  snippet: string | null;
  message: string;
  fix: string | null;
  docUrl: string;
  quote: string;
}

export interface Rule {
  id: string;
  severity: Severity;
  title: string;
  /** True when the rule compares code with the Flagsmith configuration. */
  needsLive: boolean;
  docUrl: string;
  /** Wording from Flagsmith's documentation or SDK type files that the rule is based on. */
  quote: string;
  /** Returns the parts of each finding that differ from the rule defaults. */
  check(facts: Facts, live: LiveState | null): Partial<Finding>[];
}
