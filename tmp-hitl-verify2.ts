import { scoreTaskRisk } from './coordinate/hitl-gate.ts';

console.log("=== SECURITY BYPASS PROBES ===");
// force_push underscore variants
const fp1 = scoreTaskRisk("force_push main branch");
const fp2 = scoreTaskRisk("force_push master");
const fp3 = scoreTaskRisk("git force_push origin main --all");
console.log("force_push main:", fp1, fp1 !== 'critical' && fp1 !== 'high' ? '⚠️  BYPASS' : '✓');
console.log("force_push master:", fp2, fp2 !== 'critical' && fp2 !== 'high' ? '⚠️  BYPASS' : '✓');
console.log("git force_push origin main --all:", fp3, fp3 !== 'critical' && fp3 !== 'high' ? '⚠️  BYPASS' : '✓');

// migrate + safe qualifier bypass
const m1 = scoreTaskRisk("review and migrate the production database");
const m2 = scoreTaskRisk("check and migrate all tables to new cluster");
const m3 = scoreTaskRisk("analyze and migrate production data");
const m4 = scoreTaskRisk("inspect migration of production schema");
console.log("\nreview+migrate+prod:", m1, m1 === 'low' ? '⚠️  BYPASS' : '✓');
console.log("check+migrate+tables:", m2, m2 === 'low' ? '⚠️  BYPASS (expected medium/high)' : '✓');
console.log("analyze+migrate+prod data:", m3, m3 === 'low' ? '⚠️  BYPASS' : '✓');
console.log("inspect migration prod schema:", m4, m4 === 'low' ? '⚠️  BYPASS' : '✓');

// isTestContext ordering: does it bypass when delete IS near dangerous target in test context?
const t1 = scoreTaskRisk("Add unit tests for delete production records method");
const t2 = scoreTaskRisk("test the delete schema operation");  
const t3 = scoreTaskRisk("write unit tests covering delete table operations");
console.log("\ntest+delete+production (nearby):", t1, '(expect critical)');
console.log("test+delete+schema (nearby):", t2, '(expect critical)');
console.log("test+delete+table (nearby):", t3, '(expect critical)');

// DEBUG_RISK dead variable
console.log("\n=== DEAD CODE CHECKS ===");
// drop table in HIGH regex (should be caught by critical first)
const dt = scoreTaskRisk("drop table users");
console.log("drop table (HIGH dead code):", dt, dt === 'critical' ? '✓ caught by critical nearMatch' : '?');

// comment mismatch: "review and delete schema" comment says 'high' but...
const rds = scoreTaskRisk("review and delete schema");
console.log("review and delete schema:", rds, "(comment says 'high', actual is", rds + ")");

// nearMatch boundary: exactly 80 chars gap
const boundary80 = "delete" + "x".repeat(80) + "production";
const boundary81 = "delete" + "x".repeat(81) + "production";
console.log("\n=== PROXIMITY BOUNDARY ===");
console.log("delete + 80 padding + production:", scoreTaskRisk(boundary80), "(gap=80, expect: critical)");
console.log("delete + 81 padding + production:", scoreTaskRisk(boundary81), "(gap=81, expect: low/medium)");
// Note: gap is bStart - aEnd = (6+80) - 6 = 80. Math.abs(6 - 86) = 80. <= 80? yes → CRITICAL
// For 81: Math.abs(6 - 87) = 81 > 80 → not critical from nearMatch → phrase or HIGH? No → medium? No → low
