# API Refactoring

Refactor API with proper layering.

---

## TASK-01: Create repository layer
Priority: P0
Files: src/repositories/base.ts (create), src/repositories/user.ts (create)
Depends on: none
Acceptance: UserRepository with CRUD methods

## TASK-02: Create service layer
Priority: P1
Files: src/services/user.ts (create)
Depends on: TASK-01
Acceptance: UserService calls repository

## TASK-03: Create controller layer
Priority: P1
Files: src/controllers/user.ts (create)
Depends on: TASK-02
Acceptance: UserController handles HTTP

## TASK-04: Update routes
Priority: P2
Files: src/routes/users.ts (modify)
Depends on: TASK-03
Acceptance: Routes use new controller

## TASK-05: Add validation middleware
Priority: P2
Files: src/middleware/validate.ts (create)
Depends on: TASK-01
Acceptance: Request validation middleware works

## TASK-06: Integration tests
Priority: P3
Files: tests/integration/users.test.ts (create)
Depends on: TASK-04, TASK-05
Acceptance: All user endpoints tested
