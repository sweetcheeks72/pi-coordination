# Background Task Execution

This file documents the background task execution feature implemented in
`coordinate/background-runner.ts`.

## Usage

```typescript
// In pi tool call:
coordinate({
  plan: "./specs/my-spec.md",
  background: true,  // detach and return immediately
})

// Returns:
// [background] run abc12345 started — spec: my-spec
//   watch: tail -f ~/.pi/runs/abc12345/run.log
//   status: cat ~/.pi/runs/abc12345/status.json
//   or: bash scripts/pi-status.sh abc12345
```

## CLI

```bash
scripts/pi-status.sh           # list all runs
scripts/pi-status.sh abc12345  # details + log tail for a specific run
```

## Status file

`~/.pi/runs/{id}/status.json`:
```json
{
  "id": "abc12345",
  "specPath": "/path/to/spec.md",
  "startedAt": "2026-03-09T22:00:00Z",
  "status": "running",
  "pid": 12345,
  "logPath": "~/.pi/runs/abc12345/run.log",
  "statusPath": "~/.pi/runs/abc12345/status.json"
}
```

## Notification

On macOS, a system notification is sent on completion via `osascript`.
On other platforms, a terminal bell character + console log is used as fallback.
