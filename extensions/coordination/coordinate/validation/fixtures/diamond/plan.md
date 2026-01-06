# Diamond Dependency Test Plan

Four workers with diamond dependency pattern: A -> B,C -> D

## Steps

1. Worker A: Create types.ts with User interface (id: string, name: string)
2. Worker B: Create service.ts that imports User from types.ts and exports createUser function
3. Worker C: Create validator.ts that imports User from types.ts and exports validateUser function
4. Worker D: Create index.ts that imports from service.ts and validator.ts, exports main function
