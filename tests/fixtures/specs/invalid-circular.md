# Invalid Spec - Circular Dependencies

This spec has circular dependencies.

---

## TASK-01: First task
Priority: P1
Files: src/a.ts (create)
Depends on: TASK-03
Acceptance: A is created

## TASK-02: Second task
Priority: P1
Files: src/b.ts (create)
Depends on: TASK-01
Acceptance: B is created

## TASK-03: Third task
Priority: P1
Files: src/c.ts (create)
Depends on: TASK-02
Acceptance: C is created
