# File Conflict Test Plan

Two workers attempting to modify the same file - tests reservation system.

## Steps

1. Worker A: Create shared.ts with base configuration
2. Worker B: Modify shared.ts to add additional configuration (should wait for A's reservation)
