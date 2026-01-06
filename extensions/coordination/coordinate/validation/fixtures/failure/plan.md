# Deliberate Failure Test Plan

Plan designed to cause worker failure - tests error handling.

## Steps

1. Worker A: Create a file with syntax error (deliberately malformed code)
2. Worker B: Import from the malformed file (should fail)
