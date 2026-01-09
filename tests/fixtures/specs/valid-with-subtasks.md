# Database Migration Feature

Migrate database to connection pooling.

---

## TASK-01: Setup migration framework
Priority: P0
Files: src/db/migrations.ts (create)
Depends on: none
Acceptance: Migration runner executes scripts in order

## TASK-02: Migrate user queries
Priority: P1
Files: src/db/users.ts (modify)
Depends on: TASK-01
Acceptance: All user queries use connection pool

This is a complex task that will likely need subtasks.

## TASK-02.1: Update user read queries
Priority: P1
Files: src/db/users.ts (modify)
Depends on: TASK-02
Acceptance: SELECT queries use pool.query()

## TASK-02.2: Update user write queries
Priority: P1
Files: src/db/users.ts (modify)
Depends on: TASK-02
Acceptance: INSERT/UPDATE/DELETE queries use pool.query()

## TASK-03: Add tests
Priority: P2
Files: tests/db/users.test.ts (create)
Depends on: TASK-02
Acceptance: 90% test coverage on user queries
