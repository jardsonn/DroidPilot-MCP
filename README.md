[Português (Brasil)](./README.pt-BR.md)

# DroidPilot

**Build-aware MCP server for Android app development agents.**

DroidPilot gives coding agents a practical local loop for native Android development: build the app, install it, launch it on an emulator or device, inspect the UI, interact with it, and read logs and runtime health back as structured JSON.

It is built for the workflow agents actually need:

`edit Kotlin / Compose code -> build -> install -> launch -> inspect UI -> interact -> verify -> iterate`

---

## Why DroidPilot

Most Android automation tools assume you already have a running app or a finished test suite. DroidPilot starts earlier in the cycle.

It is:

- **Build-aware**: understands Gradle projects, runs `assembleDebug`, parses build failures, and returns agent-friendly diagnostics.
- **Agent-first**: exposes a compact MCP tool surface that works well inside Claude Code, Codex, Cursor, and similar environments.
- **UI-capable**: captures accessibility snapshots, references elements as `@e1`, `@e2`, and so on, and can perform actions like `tap`, `fill`, `scroll`, and `back`.
- **Local-dev focused**: optimized for the "I changed code, now prove the Android app still works" loop.

---

## Current Status

DroidPilot already supports the main local Android feedback loop:

- project detection
- device discovery
- build / install / launch
- accessibility snapshots
- basic UI interaction
- screenshot capture
- log collection
- app health checks


Current scope:

- **transport**: stdio MCP
- **target**: local development
- **focus**: Android agents working against real projects

Known limitations:

- one active session per server instance
- UI quality depends on the app exposing useful accessibility metadata
- no HTTP transport yet
- no assertion or snapshot diff tools yet

---

## What Agents Can Do

With DroidPilot, an agent can:

1. detect an Android project from its root folder
2. choose a ready emulator by default, or a specific `deviceSerial`
3. run a Gradle build
4. install and launch the app
5. inspect the current UI in a compact form
6. tap buttons, fill fields, scroll lists, and navigate back
7. capture screenshots
8. collect logs and runtime health information
9. iterate on code changes using the same local Android loop

---

## Architecture

```mermaid
flowchart LR
    A[AI Agent\nClaude Code / Codex / Cursor] -->|MCP over stdio| B[DroidPilot MCP Server]
    B --> C[Gradle Engine]
    B --> D[ADB Engine]
    B --> E[Session Manager]
    C --> F[Android Project]
    D --> G[Android Emulator or Device]
```

### Main components

- **MCP server**
  Registers the tools used by the agent.

- **Gradle engine**
  Detects Android projects, resolves the Gradle wrapper, runs builds, parses failures, and discovers APK metadata.

- **ADB engine**
  Resolves `adb`, discovers devices, captures UI snapshots, launches apps, and performs interactions.

- **Session manager**
  Keeps the current project, device, package name, and latest snapshot across tool calls.

---

## Requirements

- Node.js 18+
- npm
- JDK installed
- Android SDK installed
- Android SDK Platform-Tools installed
- Android Build-Tools installed
- a running Android emulator or a connected Android device
- an Android project with:
  - `settings.gradle` or `settings.gradle.kts`
  - `gradlew` or `gradlew.bat`

Notes:

- On Windows, DroidPilot can automatically resolve `adb.exe` from common Android SDK locations.
- If more than one device is connected, DroidPilot can prefer an emulator or use an explicit `deviceSerial`.

---

## Installation

```bash
git clone https://github.com/your-org/droidpilot-mcp.git
cd droidpilot-mcp
npm install
npm run build
```

Run tests:

```bash
npm test
```

Run the server directly:

```bash
npm start
```

Run in development mode:

```bash
npm run dev
```

---

## MCP Client Integration

### Claude Code

Register DroidPilot as an MCP server:

```bash
claude mcp add droidpilot -- node /absolute/path/to/droidpilot-mcp/build/index.js
```

Windows example:

```powershell
claude mcp add droidpilot -- node "C:\Users\User\WebstormProjects\droidpilot-mcp\build\index.js"
```

After adding the server, restart or refresh the session if needed so the MCP list is reloaded.

### Claude Desktop

Example configuration:

```json
{
  "mcpServers": {
    "droidpilot": {
      "command": "node",
      "args": ["/absolute/path/to/droidpilot-mcp/build/index.js"]
    }
  }
}
```

### Cursor

Example `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "droidpilot": {
      "command": "node",
      "args": ["/absolute/path/to/droidpilot-mcp/build/index.js"]
    }
  }
}
```

### Other MCP clients

DroidPilot uses the standard MCP stdio transport, so any client that can spawn a local stdio MCP server can integrate with it.

---

## Quick Start With an Android Project

Once DroidPilot is registered in your MCP client, open your Android project and ask the agent to run a smoke test:

```text
Use the droidpilot MCP to test this Android project.

1. Call devices.
2. Call open with projectDir equal to the root of this Android project and preferEmulator true.
3. Call run.
4. Call snapshot with interactiveOnly true.
5. Tell me:
   - whether the app launched
   - which device was used
   - which screen/activity is open
   - and if anything failed, show summary, errors, and outputTail
```

If you want to force a specific emulator:

```text
Use the droidpilot MCP in this Android project.
Call open with projectDir equal to the project root and deviceSerial "emulator-5554".
Then call run and snapshot.
```

---

## Typical Agent Workflow

```text
1. open
2. run
3. snapshot
4. tap / fill / scroll / back
5. snapshot again
6. health + logs
7. edit code
8. run again
```

This is the intended local iteration loop:

- modify Android code
- rebuild and relaunch
- inspect the resulting UI
- perform a user action
- validate the next screen or state
- repeat

---

## MCP Tool Reference

### `devices`

Lists all connected Android devices and emulators, plus the default device DroidPilot would choose.

Typical output:

```json
{
  "adbPath": "C:\\Users\\User\\AppData\\Local\\Android\\Sdk\\platform-tools\\adb.exe",
  "defaultDeviceSerial": "emulator-5554",
  "devices": [
    {
      "serial": "emulator-5554",
      "type": "emulator",
      "model": "sdk gphone64 x86 64",
      "apiLevel": "36",
      "status": "device"
    }
  ]
}
```

### `open`

Starts a DroidPilot session by:

- validating the Android project
- selecting a device
- storing project and device state for later tool calls

Arguments:

- `projectDir: string`
- `deviceSerial?: string`
- `preferEmulator?: boolean`

### `close`

Closes the current session and stops the app when possible.

### `build`

Runs a Gradle build for the attached Android project.

Arguments:

- `clean?: boolean`

Returns:

- build status
- build duration
- structured errors
- warning count
- summary
- output tail for debugging

### `run`

Runs the full build-install-launch sequence.

Arguments:

- `clean?: boolean`

Returns:

- launch status
- package name
- launch activity
- APK path
- build duration
- warnings
- summary

### `snapshot`

Captures the current UI hierarchy and returns compact references such as `@e1`, `@e2`, and so on.

Arguments:

- `interactiveOnly?: boolean` (default: `true`)

Returns:

- current screen/activity
- current package
- element count
- simplified element list

### `tap`

Taps an element from the latest snapshot.

Arguments:

- `ref: string`

### `fill`

Focuses a text field, clears it, and types new text.

Arguments:

- `ref: string`
- `text: string`

### `scroll`

Scrolls the active screen.

Arguments:

- `direction: "up" | "down" | "left" | "right"`

### `back`

Presses the Android Back button.

### `screenshot`

Captures a PNG screenshot from the current device.

Arguments:

- `outputPath?: string`

### `logs`

Returns recent app logs, filtered by app PID when possible.

Arguments:

- `maxLines?: number`

### `health`

Returns app runtime signals:

- whether the app is running
- PID
- memory usage
- recent crash indicators from logs

---

## Example Outputs

### `open`

```json
{
  "status": "ok",
  "session": "s1775879638637",
  "project": {
    "dir": "C:\\Users\\User\\AndroidStudioProjects\\MyApp",
    "module": "app",
    "applicationId": "com.example.myapp",
    "buildVariant": "debug"
  },
  "device": {
    "serial": "emulator-5554",
    "type": "emulator",
    "model": "sdk gphone64 x86 64",
    "apiLevel": "36",
    "status": "device"
  }
}
```

### `run`

```json
{
  "status": "running",
  "package": "com.example.myapp",
  "activity": "com.example.myapp/.MainActivity",
  "apkPath": "C:\\path\\to\\app-debug.apk",
  "buildDurationMs": 19876,
  "incremental": true,
  "warningsCount": 0,
  "summary": "Build completed successfully."
}
```

### `snapshot`

```json
{
  "status": "ok",
  "screen": "com.example.myapp/.MainActivity",
  "package": "com.example.myapp",
  "elementCount": 4,
  "elements": [
    {
      "ref": "@e1",
      "type": "Button",
      "text": "Continue",
      "clickable": true,
      "focusable": true,
      "scrollable": false,
      "editable": false,
      "enabled": true
    }
  ]
}
```

---

## Example Agent Prompts

### Smoke test a project

```text
Use the droidpilot MCP to test this Android project.

1. Call devices.
2. Call open with projectDir equal to the root of this project and preferEmulator true.
3. Call run.
4. Call snapshot with interactiveOnly true.
5. Tell me if the app launched successfully, which device was used, and which screen/activity is open.
```

### Verify a UI navigation flow

```text
Use the droidpilot MCP in this Android project.

1. Call open with projectDir equal to the project root and deviceSerial "emulator-5554".
2. Call snapshot with interactiveOnly true.
3. Tap the profile tab in the bottom navigation.
4. Call snapshot again and compare the screen/activity.
5. Run health and logs.
6. Tell me whether the navigation worked and whether there are crashes or relevant errors.
```

### Run an edit-verify loop

```text
Use the droidpilot MCP as part of your Android edit loop.

Whenever you change code:
1. Call run.
2. If build fails, inspect summary, errors, and outputTail and fix the code.
3. If build succeeds, call snapshot.
4. Interact with the new UI if needed.
5. Use health and logs to validate the result before making the next change.
```

---

## Reliability Notes

DroidPilot is designed to be resilient in the places that matter most during local Android development:

- resolves `adb` automatically instead of assuming it is on `PATH`
- prefers an emulator when both a phone and an emulator are connected
- still supports explicit `deviceSerial` when deterministic selection is needed
- supports `gradlew.bat` on Windows
- parses common build failure patterns into structured diagnostics
- uses a real XML parser for UI snapshots
- attempts to resolve the launchable activity instead of assuming `.MainActivity`

That said, DroidPilot still depends on the realities of Android automation:

- UI automation quality is limited by the app's accessibility tree
- some apps and screens expose sparse or poor accessibility metadata
- custom views without accessibility labels are harder for any agent to use reliably

---

## Troubleshooting

### `ADB_NOT_FOUND`

Meaning:

- DroidPilot could not resolve `adb`

What to check:

- Android SDK is installed
- Platform-Tools are installed
- `ANDROID_SDK_ROOT` or `ANDROID_HOME` is set if auto-discovery is not enough

### `PROJECT_NOT_FOUND`

Meaning:

- `projectDir` does not look like an Android project root

What to check:

- the folder contains `settings.gradle` or `settings.gradle.kts`
- the folder contains `gradlew` or `gradlew.bat`

### `build_failed`

Meaning:

- Gradle failed or the APK could not be produced

What to inspect:

- `summary`
- `errors`
- `outputTail`

### `launch_failed`

Meaning:

- the app was built and installed, but DroidPilot could not start it

What to inspect:

- package name
- launch activity
- logs
- whether the APK manifest exposes a launchable activity

### `snapshot` returns too little information

Meaning:

- the current screen may expose limited accessibility metadata

What to try:

- run `snapshot` with `interactiveOnly: false`
- use `screenshot`
- verify accessibility labels in the app itself

### Wrong device was selected

Use an explicit serial:

```text
Call open with projectDir equal to the project root and deviceSerial "emulator-5554".
```

---

## Development

### Scripts

```bash
npm run build
npm run dev
npm run start
npm test
```

### Project structure

```text
src/
  index.ts              MCP server and tool registration
  engines/
    adb.ts              Device discovery, UI inspection, interaction, logs
    gradle.ts           Project detection, build execution, APK discovery
    session.ts          Active session state

build/
  Compiled JavaScript output

test/
  gradle.test.mjs       Build engine smoke and regression tests
```

### Suggested local validation

When working on DroidPilot itself, a useful validation sequence is:

1. `npm test`
2. start or verify an emulator is running
3. connect DroidPilot to an MCP client
4. run:
   - `devices`
   - `open`
   - `snapshot`
5. then test a real Android app with:
   - `run`
   - `snapshot`
   - `tap`
   - `health`
   - `logs`

---

## Roadmap

- snapshot diffing
- assertion tools
- flow recording and replay
- better selectors for Compose-heavy apps
- HTTP transport / daemon mode
- CI integration
- richer artifact capture
- multi-session support

---

## License

MIT
