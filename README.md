# Pixel Tile Editor

## Project Theme
This repository is dedicated to a standalone **Tile Editor** application centered on pixel-art workflows.

The long-term direction is a focused editor for consistent, grid-based tile authoring, with an emphasis on clear rendering and a maintainable desktop-oriented architecture.

## Locked-In Tech Stack
Future changes in this repository should align with the following baseline stack:

- **App foundation:** Vite
- **UI framework:** React
- **Language:** TypeScript
- **Rendering approach:** HTML5 Canvas (primary drawing/rendering surface)
- **Desktop packaging target:** Tauri (preferred), with Electron as a secondary fallback if packaging constraints require it

## Architectural Direction (High Level)
The application should remain a web-tech-based desktop app architecture:

- Vite for development/build tooling
- React + TypeScript for interface and editor orchestration
- Canvas for pixel-precise rendering/editing loops
- Desktop bundling via Tauri as the default standalone delivery path

## Guidance for Future Agents
When proposing, implementing, or refactoring code in this repository:

1. Preserve the stack above unless explicitly instructed otherwise by a human maintainer.
2. Keep implementation choices compatible with a standalone desktop app workflow.
3. Treat this README as the source-of-truth for baseline technology decisions.

## Change Control
Any proposal to change the locked-in stack should be treated as an architectural decision and should be explicitly approved before implementation.
