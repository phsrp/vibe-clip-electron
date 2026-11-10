<div align="center">

# Vibe Clip (Electron version, discontinued)

</div>

> [!IMPORTANT]
> **This version of Vibe Clip is discontinued and won't get any more updates.**
> Vibe Clip continues in a new repository: **[phsrp/vibe-clip](https://github.com/phsrp/vibe-clip)**.
> It was rebuilt in Rust as a fork of [HasteClip](https://github.com/hasteclip/hasteclip): it runs natively instead of through Electron and a separate OBS engine, and adds frame blending.
>
> **To switch:** download `VibeClip-win-Setup.exe` from the [new repository's latest release](https://github.com/phsrp/vibe-clip/releases/latest) and run it. Your old clips are normal MP4 files and stay in `Videos\Vibe Clip`.

This repository is kept so the old code stays available.

## What this was

- **Instant clips:** the replay buffer is always on in the background. Press **Alt+F10** and the last 3 minutes (you choose the length) are saved as a clip, with a small pop-up over your game to confirm it.
- **Recording:** record the whole session with **Alt+F9**. Uses your graphics card's encoder (NVIDIA NVENC, AMD AMF or Intel QuickSync) so your game doesn't slow down, with x264 as a fallback.
- **The OBS engine inside:** Vibe Clip runs on libobs, the same engine as OBS Studio, so you get OBS quality and every OBS option.
- **Games are recognised:** osu!, Counter-Strike 2, Geometry Dash, Valorant and Roblox out of the box, and you can add any game by its .exe name. Clips are tagged and sorted by game, with the game's real icon, and osu! clips are named after the song you were playing.
- **Clip library:** clips grouped by day, game folders with counts, collections, search, rename, delete (to the Recycle Bin) and a built-in player.
- **Screenshots:** **Alt+F12** saves a full-resolution screenshot into the library.
- **Profiles** (what OBS calls scenes): display, window, game capture, webcam, microphones, desktop audio, single-app audio, images, text, browser sources and more. Every source has all of its OBS settings, plus position, crop and filters (green screen, colour correction, noise suppression and every other OBS filter).
- **Audio mixer:** live level meters, volume, mute, monitoring, sync offset, and you choose which of the **6 audio tracks** each source goes to.
- **Built-in editor:** trim, split, remove parts and crop (16:9, 9:16 for shorts, 1:1...), then save as a new clip. The original is never changed.
- **Streaming:** go live on Twitch, YouTube, Kick or any RTMP/WHIP server, with its own encoder settings. Your stream key is stored encrypted.
- **Import from OBS:** bring over your OBS settings (encoder, bitrate, tracks, hotkeys, stream key) and your scenes, which become profiles with their sources, positions, filters and audio routing.
- **Runs in the tray** so the replay buffer keeps going with the window closed, and it can start with Windows
- **Updates itself:** tells you when a new version is out and asks before downloading
- **Themes:** Default, Gruvbox and Rosé Pine, each with a dark and a light mode (Rosé Pine's light mode is Rosé Pine Dawn)

## Previews

<div align="center">

<img src="docs/main.png" alt="The clip library with clips grouped by day and sorted by game" width="100%">

<img src="docs/sources.png" alt="Profiles with the live preview, sources, mixer and filters" width="48%"> <img src="docs/editor.png" alt="The editor with parts removed and a vertical crop" width="48%">

<img src="docs/settings.png" alt="Settings with every encoder option" width="48%"> <img src="docs/theme.png" alt="The Rosé Pine theme" width="48%">

</div>

## Previews

<div align="center">

<img src="docs/main.png" alt="The clip library with clips grouped by day and sorted by game" width="100%">

<img src="docs/sources.png" alt="Profiles with the live preview, sources, mixer and filters" width="48%"> <img src="docs/editor.png" alt="The editor with parts removed and a vertical crop" width="48%">

<img src="docs/settings.png" alt="Settings with every encoder option" width="48%"> <img src="docs/theme.png" alt="The Rosé Pine theme" width="48%">

</div>

## Built with

- [Electron](https://www.electronjs.org/), [React](https://react.dev/) and [electron-vite](https://electron-vite.org/)
- [OBS Studio](https://obsproject.com/)'s engine (libobs, GPL-2.0) through Streamlabs' [obs-studio-node](https://github.com/stream-labs/obs-studio-node) (GPL-2.0), for capture, encoding, the replay buffer, filters and streaming. Because of this, Vibe Clip is released under the [GPL-2.0](LICENSE) too.
- [FFmpeg](https://ffmpeg.org/) (shipped with obs-studio-node) for thumbnails, converting recordings and editor exports
- [electron-updater](https://www.electron.build/auto-update) for updates
- The editor's timeline is a simplified version of the one in [Vibe Editing Suite](https://github.com/phsrp/Vibe-editing-suite)
- [Montserrat](https://github.com/JulietaUla/Montserrat) font (SIL Open Font License)
- [Tabler Icons](https://tabler.io/icons) (MIT)
- [Rosé Pine](https://rosepinetheme.com/) (MIT) and [Gruvbox](https://github.com/morhetz/gruvbox) (MIT) colours
