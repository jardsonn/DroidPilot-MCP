# DroidPilot — Agent Skill

Automates the full cycle of building, deploying, inspecting, and interacting with Android apps on emulators. Use for Android/Kotlin development workflows where you need to verify that UI changes work correctly.

## Prerequisites

- Android SDK with `adb` in PATH
- Running Android emulator or connected device (`adb devices` shows it)
- Android project with `gradlew` and `settings.gradle(.kts)`
- Java/JDK installed (JAVA_HOME set)

## Canonical Workflow

```
open <project-dir>     → detect project + find device
run                    → build + install + launch (one step)
snapshot               → get UI elements with refs (@e1, @e2, ...)
tap @e3                → tap a button
fill @e2 "text"        → type into a field
snapshot               → see what changed
health                 → check if app crashed
close                  → end session
```

## Key Commands

| Command | When to use |
|---------|-------------|
| `open` | Always first. Sets up project + device. |
| `run` | After editing code. Builds + installs + launches. |
| `build` | When you only need to check for compilation errors. |
| `snapshot` | After any navigation/tap to see current UI state. |
| `tap @eN` | Click buttons, tabs, menu items. |
| `fill @eN "text"` | Type into TextFields. |
| `scroll up/down` | Scroll to find elements off-screen. |
| `back` | Navigate back. |
| `screenshot` | When you need a visual capture. |
| `logs` | When debugging crashes or unexpected behavior. |
| `health` | Quick check: is the app alive? |
| `devices` | List available emulators/devices. |

## Common Patterns

### Verify a UI change after editing code
```
run → snapshot → assert element exists → close
```

### Debug a crash
```
run → (crash happens) → health → logs --maxLines 100 → fix code → run
```

### Test a user flow (e.g., login)
```
run → snapshot → fill @e1 "user@email.com" → fill @e2 "password"
→ tap @e3 → snapshot → verify welcome screen → close
```

## Tips

- Always call `snapshot` after `tap` or `fill` to see the updated UI.
- Use `snapshot` with `interactiveOnly: true` (default) to save tokens.
- `run` does build+install+launch — you rarely need `build` separately.
- If `run` returns build errors, fix the code and `run` again.
- Check `health` if the app stops responding.
