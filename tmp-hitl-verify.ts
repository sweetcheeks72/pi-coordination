import { scoreTaskRisk } from './coordinate/hitl-gate.ts';

const cases: Array<[string, string, string]> = [
  // force_push variants — CRITICAL path check
  ['force_push main branch', 'critical', 'underscore force_push → should be critical'],
  ['force-push main', 'critical', 'hyphen force-push → critical'],
  ['force push main', 'critical', 'space force push → critical'],
  ['force_push origin main', 'critical', 'force_push + origin + main'],
  // migrate + safe qualifier bypass
  ['review and migrate the production database', 'high', 'review+migrate+prod → should be high (not low)'],
  ['analyze migration for production cluster', 'medium', 'migration noun in review context'],
  // isTestContext + delete near data
  ['review tests for delete data cleanup method', 'critical', 'delete near data despite test context'],
  ['Add unit tests for delete data records', 'critical', 'delete near data + test context'],
  // dead code: drop table always critical before high
  ['drop table users', 'critical', 'drop table → critical (nearMatch fires before HIGH regex)'],
  // truncate
  ['truncate data in staging', 'high', 'truncate near data → high'],
  ['Truncate tool output to 4096 chars', 'low', 'truncate in code context → low'],
  // edge cases  
  ['', 'low', 'empty string → low'],
  ['x', 'low', 'single char → low'],
  ['delete all records', 'critical', 'delete all phrase → critical'],
  // confirmed passing tests (regression check)
  ['delete the production database', 'critical', 'explicit production delete'],
  ['Run TRUNCATE TABLE users to clear test data', 'critical', 'TRUNCATE TABLE phrase'],
  ['review and delete schema', 'high', 'review + delete schema stays high'],
  ['truncate the data in the staging schema', 'high', 'truncate + data/schema proximity'],
];

let pass = 0; let fail = 0;
for (const [desc, expected, note] of cases) {
  const actual = scoreTaskRisk(desc);
  const ok = actual === expected;
  if (ok) pass++;
  else fail++;
  console.log(ok ? '✅' : '❌', `[${note}]`, '→', actual, ok ? '' : `(expected ${expected})`);
}
console.log(`\n${pass} pass, ${fail} fail`);
