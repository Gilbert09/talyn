---
title: Install Talyn
navLabel: Install
description: Download the desktop app for macOS, Windows or Linux, or use Talyn in your browser at app.talyn.dev.
---

Talyn runs as a desktop app on macOS, Windows and Linux, and as a web app in your browser. Both use the same account, so your workspaces, sessions and pull requests are the same on each.

## Use the web app

Go to [app.talyn.dev](https://app.talyn.dev) and sign in with GitHub. There is nothing to install.

## Install the desktop app

Get the installer from the [download page](/download), or pick a file from the [releases page on GitHub](https://github.com/Gilbert09/talyn/releases).

### macOS

The download button gives you the Apple silicon `.dmg`. On an Intel Mac, get the x64 `.dmg` from the releases page.

1. Open the `.dmg`.
2. Drag Talyn into your Applications folder.
3. Open Talyn from Applications.

The macOS app is signed and notarized by Apple.

### Windows

The Windows installer is a `.exe` for x64. It is not code-signed yet, so Windows SmartScreen shows a warning the first time you run it.

1. Run the installer.
2. If SmartScreen says "Windows protected your PC", select **More info**.
3. Select **Run anyway**.

### Linux

The Linux build is an AppImage for x64.

1. Make the file executable:

   ```bash
   chmod +x Talyn-*.AppImage
   ```

2. Run it:

   ```bash
   ./Talyn-*.AppImage
   ```

## Desktop or web

Most of Talyn works the same in both. The desktop app adds a few things that need your computer:

- Sessions that run in a git worktree on your own machine, with your own tools.
- Opening a sandbox's dev server on `localhost`.
- Skills from `~/.claude/skills` on your machine.
- Your own instruction files, such as `~/.claude/CLAUDE.md`, copied into sandbox sessions.
- One-click sign-in to ChatGPT for Codex.

## Updates

The desktop app updates itself. A new release goes out every six hours when there is something new in it.

## Next

[Quickstart](/docs/quickstart): sign in, connect GitHub and an agent, and start your first session.
