# STP — Hands-Free Voice Assistant for Claude Code and Antigravity

[![Open VSX](https://img.shields.io/open-vsx/v/nizzynas/vtp-voice-prompt?style=flat&label=Open%20VSX&color=C160EF)](https://open-vsx.org/extension/nizzynas/vtp-voice-prompt)
[![License: MIT](https://img.shields.io/badge/License-MIT-gray?style=flat)](LICENSE)

Wake it with a phrase. Dictate. Send by voice. STP works the way "hey Siri" works — except instead of opening apps or setting timers, it talks to your AI coding assistant for you. Works with Antigravity or Claude Code. You pick the target, you pick the chat.

student working on a side project. Once the voice pipeline was reliable enough to use, I started building the rest of the extension with the extension. 

> Internally the package is named VTP (Voice to Prompt). It's the same project — STP is the user-facing name, VTP is the codename / repo / package id.

---

## Watch the Demo

<p align="center">
  <a href="https://www.youtube.com/watch?v=fAC30bak_xY">
    <img src="https://img.youtube.com/vi/fAC30bak_xY/maxresdefault.jpg" alt="STP Hands-Free Demo Video" width="720" />
  </a>
  <br />
  <em>Click to open on YouTube</em>
</p>

---

## How It Works

The full loop — start, dictate, send, repeat — happens by voice. No mouse. No keyboard. No focus required.

Say your wake phrase and STP starts listening. The default is **"hey antigravity"** — change it in Settings. Then dictate naturally and end with something like "send the prompt." STP routes it into either Antigravity or Claude Code, whichever you've selected as the target.

### Two listening modes

| Mode | What happens after a prompt is sent |
|---|---|
| **Voice Activated** *(default)* | Mic idles. Say your wake phrase to start the next prompt. |
| **Continuous** | Mic auto-restarts immediately. Just keep talking. |

Switch in the Settings menu inside the panel.

### Pick your target — Antigravity or Claude Code

A button in the panel header (`→ AG` / `→ CC`) toggles which AI chat receives your prompts. The voice flow doesn't change — only where the prompt lands.

When the target is Claude Code, the context card below the button becomes a chat lock. You can have five Claude Code conversations open and only the one you locked will receive the prompt — the others get nothing. Switch back to Antigravity and the lock is preserved (so the next time you flip to Claude, it remembers).

### Send while you're tabbed out

Injection doesn't need focus. Start a prompt by voice, alt-tab to a browser to look at docs or scroll through something, say "send the prompt" — it lands. The chat is in your IDE, not your active window.

---

## What You Can Say

### Basic flow — dictate and send

> *"**Hey antigravity.** Build a staff availability page. Each staff member sets their weekly schedule with a calendar UI. Use the existing dashboard card styling. **Send the prompt.**"*

STP hears `send the prompt`, runs an auto-clean pass to strip filler words, and injects the cleaned prompt into the target you picked.

### Enhance flow — let Gemini rewrite it

> *"**Hey antigravity.** I need a modal that blocks staff from setting availability until they've saved their service category. **Enhance this prompt.**"*

Gemini rewrites it into a more specific prompt using workspace context (open files, recent conversation history). Review it inline:

> *"Approve."* → fires into the target.
> *"Reject."* → restores your original.
> *"Try again."* → Gemini takes another pass.

### Clean flow — review the cleanup before sending

> *"**Hey antigravity.** Add rate limiting to the API — hold on, sorry — add a 429 response with a Retry-After header. **Clean up and review.**"*

`Clean up and review` runs the same cleanup pass that runs silently before every send, but shows you the result first so you can approve, reject, or regenerate it. `Clean it up` does the same cleanup but applies it without a preview.

### Pause and resume — mid-session

> *"**Hey antigravity.** Build a login page with Google OAuth and — **pause.**"*

Mic mutes. Buffer preserved. Later:

> *"Resume."* → mic wakes exactly where you left off.

---

## Why This Saves Tokens

Every prompt runs through an automatic cleanup before it's injected. The cleanup strips filler words ("uh", "um", "like"), collapses immediate word repeats ("the the navbar" → "the navbar"), and tidies whitespace.

For long dictated prompts that's anywhere from 5–30% fewer input tokens — every send. The cleanup is regex-only by default, so most sends cost zero extra API calls. It only escalates to a small Gemini pass when the buffer has obvious self-corrections (you said "actually" or "I mean" mid-sentence) or heavy filler density.

Auto-cleanup is skipped when the prompt has already been enhanced or cleaned via `clean it up` / `clean up and review`, so you never pay the cleanup cost twice.

---

## What's Under the Hood

- **Audio pipeline** — local FFmpeg capture, denoise, and chunking. Audio never goes to a third party for transcription unless you opt into Deepgram.
- **Real-time transcription mode** — Deepgram drops voice-command latency from ~5s (Gemini chunked) to ~300ms. Free tier, optional, opt-in.
- **Auto-clean before send** — regex strips fillers locally; Gemini cleanup only runs when the buffer is genuinely noisy.
- **Prompt enhancement** — Gemini rewrites your dictation as a spec-style prompt using your open files and recent conversation as context.
- **Approve / Reject / Try Again** — review enhancements with buttons or by voice.
- **Pause / resume** — `pause` mutes the mic, `resume` brings it back, buffer kept intact across the gap.
- **Target switching** — one button toggles between Antigravity and Claude Code. Settings, lock state, and wake phrase persist across switches.
- **Per-conversation chat lock** *(Claude Code)* — pick a single Claude Code chat tab as the destination so prompts don't fan out to every open conversation.
- **Focus-independent injection** — works while you're tabbed into another window or scrolling somewhere else.
- **Workspace context** — reads open files, active conversation, and workspace name for smarter enhancements.
- **Multi-conversation context** — layer past Antigravity conversations as supplementary read-only context.
- **Secure key storage** — Gemini and Deepgram keys live in VS Code SecretStorage (the OS keychain). Never in a file, never in source.
- **Built-in noise suppression** — 3-stage FFmpeg filter chain strips low-frequency rumble before audio reaches Gemini.

---

## Voice Command Reference

### Starting a session

| Say | What happens |
|---|---|
| `hey antigravity` *(default)* | Starts listening — no click needed |
| Any custom wake phrase | Configurable in Settings |

### While dictating

Most commands work **mid-sentence** — say them naturally as part of your dictation.

| Say | What happens |
|---|---|
| *(just talk)* | Appends to your prompt buffer |
| `send it` / `send the prompt` | Auto-cleans, then injects into the current target |
| `enhance this prompt` | Gemini rewrites it. Review inline by voice |
| `clean it up` / `scrub that` | Cleans the buffer in place. Silent — no preview |
| `clean up and review` | Cleans + shows preview. Approve / Reject / Try Again inline |
| `approve` / `reject` / `try again` | Controls the enhancement or clean-review preview |

> Auto-cleanup runs silently before every send unless the buffer is already enhanced or cleaned. You don't have to ask for it.

### Pause and resume

| Say | What happens |
|---|---|
| `pause` / `mute` / `stop listening` | Mutes mic immediately; buffer preserved |
| `resume` / `I'm back` | Wakes back up exactly where you left off |
| `pause and pull up [url]` | Pauses and opens the URL in one command |

### Side commands

These trigger actions without touching your prompt buffer.

| Say | What happens |
|---|---|
| `pull up [url or topic]` | Opens URL or fires into Antigravity chat |
| `search for [query]` / `look up [query]` | Searches via Antigravity MCP |
| `navigate to [url]` / `browse to [url]` | Opens the URL directly |

### Clear

| Say | What happens |
|---|---|
| `clear transcript` / `clear that` | Discards the current buffer — must be said alone |
| `start over` | Resets the buffer |

> Commands fire ~10x faster in Deepgram mode (~300ms) vs Gemini chunked mode (~5s).

---

## Getting Started

### 1. Install FFmpeg

**Windows (recommended via winget):**
```
winget install ffmpeg
```
Or download from [ffmpeg.org](https://ffmpeg.org/download.html) and add to your system PATH. Restart your IDE after installing.

### 2. Get a Gemini API Key

Get one at [aistudio.google.com](https://aistudio.google.com/apikey) — **no credit card required**. The free tier (~15 req/min) is enough for normal use.

### 3. Add your key to STP

Open the STP panel from the Activity Bar, click **KEY**, and paste your Gemini API key. Stored in VS Code SecretStorage.

### 4. Pick your target

Click the `→ AG` button in the panel header to flip to `→ CC` (Claude Code) or back. Default is Antigravity.

### 5. Start talking

Click the microphone button and dictate. In Gemini mode, audio processes in 3-second chunks and the transcript updates live.

### 6. (Recommended) Enable Deepgram for real-time transcription

Click **LIVE** in the panel header and follow the onboarding. ~300ms latency for voice commands instead of ~5s. Free tier covers normal use.

---

## Claude Code Support — How It Works

Claude Code's chat panel is a webview. To inject prompts into it without an official extension API, STP hot-patches the locally installed Claude Code extension on first activation. The patch:

- Adds four small commands to Claude Code's IPC (`injectPromptVTP`, `submitVTP`, `getPanelTitlesVTP`, plus internal helpers).
- Tags each chat panel with its title so STP can route to the right conversation when locked.
- Is fully reversible — run **"VTP: Restore Claude Code"** from the Command Palette to undo it.
- Re-applies automatically if Claude Code is updated. The previous patch is restored first, then the new patch is applied to the new bundle.

A backup of every patched file is stored next to the patched extension (`.vtp-backups/`) so you can roll back even if the extension is fully clean.

If you don't want any patching at all, leave the target on Antigravity. The Claude Code path is never touched.

---

## Deepgram — Real-Time Transcription (Optional)

Deepgram is an opt-in third-party service that drops transcription latency to ~300ms via real-time streaming. A **free API key** is all you need.

Click the **LIVE** button in the panel and follow the onboarding. Your key is stored in VS Code SecretStorage and only sent to Deepgram during recording.

### Deepgram Data Usage

> Based on publicly available Deepgram documentation (early 2026). See [deepgram.com/privacy](https://deepgram.com/privacy) for the authoritative source.

| Feature | Default | Opt-out |
|---|---|---|
| **Transcription** | Audio sent to Deepgram's API during recording | — |
| **Model training** | May use audio to improve models (50% discount applied) | Add `mip_opt_out=true` to API requests |
| **Data selling** | No — Deepgram does not sell your voice data | — |
| **Data retention** | Logs retained ~90 days | Opt-out: deleted after processing |
| **Compliance** | HIPAA, GDPR, CCPA, SOC-2 Type 2, TLS 1.3, AES-256 | — |

[Get a free Deepgram API key](https://console.deepgram.com) — [Privacy policy](https://deepgram.com/privacy)

> Claude Code mode requires Deepgram. Voice commands need ~300ms response time to feel like an assistant; Gemini chunked mode is too slow for that loop.

---

## Memory Context — Multi-Conversation Selection

STP automatically detects your **current Antigravity conversation** (the most recently modified chat) and feeds it into every enhancement as the primary context.

If you need to pull in knowledge from other past chats — a previous session on the same project, a different workspace's conversation — click the context card at the top of the panel.

| What | How |
|---|---|
| **Primary context** | Auto-detected (most recently modified conversation). Always active. |
| **Extra context** | Past Antigravity conversations you manually check in the picker. |
| **Adding extras** | Click the context card, tick checkboxes, press Enter. Multiple selections OK. |
| **Removing extras** | Click again, untick, press Enter. |
| **Effect** | Extra messages are appended (read-only) to the primary context when Gemini elaborates your prompt. |
| **Badge** | A purple `+N` pill appears on the card when extras are active. |

Extras are **read-only** — they inform the elaboration but cannot be modified or replace the primary auto-detected chat.

---

## Platform Support

| Platform | Status |
|---|---|
| **Windows** | Fully supported (DirectShow via FFmpeg) |
| macOS | Planned (AVFoundation) |
| Linux | Planned (ALSA) |

---

## Settings

| Setting | Default | Description |
|---|---|---|
| `vtp.injectionTarget` | `antigravity` | Which AI chat receives prompts. `antigravity` or `claude-code` |
| `vtp.claudeCodeLockedTitle` | `""` | Title of the Claude Code conversation locked as the destination (empty = fan out to all open Claude chats) |
| `vtp.vadMode` | `false` | Always-on VAD — auto-pauses after silence, restarts automatically |
| `vtp.contextDepth` | `20` | Recent conversation messages passed as context to Gemini |
| `vtp.elaborationModel` | `gemini-2.5-flash` | Gemini model used for prompt enhancement |
| `vtp.transcriptionEngine` | `gemini` | `gemini` (default, uses Gemini key) or `deepgram` (real-time, requires separate Deepgram key) |

---

## Audio Pipeline

### Gemini Mode (Default)

```
Mic → FFmpeg → [highpass=f=80] → [afftdn=nf=-25] → [silencedetect] → WAV chunks
                  Remove rumble      FFT denoiser       VAD trigger
                                                              ↓
                                                       Gemini 2.5 Flash
                                                         (transcribe)
                                                              ↓
                                                      Live transcript UI
```

1. **`highpass=f=80`** — strips sub-80Hz rumble (HVAC, desk vibration, USB hiss)
2. **`afftdn=nf=-25`** — FFmpeg's FFT denoiser; estimates noise floor in first ~0.4s and subtracts it every frame
3. **`silencedetect=noise=-40dB:d=2.5`** — triggers VAD after 2.5s of true silence (on the cleaned signal)
4. Audio is segmented into **3-second WAV chunks** and sent to Gemini for verbatim transcription
5. Each chunk's transcript is appended live to the panel as it comes back

### Deepgram Mode (Optional)

```
Mic → FFmpeg → raw s16le PCM @ 16kHz → WebSocket → Deepgram nova-2
                                                          ↓
                                                 Interim results ~300ms
                                                          ↓
                                                  Final words committed
                                                          ↓
                                                  Live transcript UI
```

No WAV files written. No chunks. Audio streams directly in real-time for near-instant feedback.

---

## Built With

[![VS Code API](https://img.shields.io/badge/VS%20Code%20Extension%20API-007ACC?style=flat&logo=visualstudiocode&logoColor=white)](https://code.visualstudio.com/api)
[![Gemini](https://img.shields.io/badge/Google%20Gemini-8E75B2?style=flat&logo=google&logoColor=white)](https://ai.google.dev/)
[![FFmpeg](https://img.shields.io/badge/FFmpeg-007808?style=flat&logo=ffmpeg&logoColor=white)](https://ffmpeg.org/)
[![Deepgram](https://img.shields.io/badge/Deepgram-101010?style=flat&logo=deepgram&logoColor=white)](https://deepgram.com/)

---

## Privacy

STP does not collect, store, or transmit any personal data.

| What | Where it goes |
|---|---|
| Audio (Gemini mode) | Captured locally by FFmpeg, sent to Gemini for transcription, then discarded. Never written to disk permanently. |
| Audio (Deepgram mode) | Streamed to Deepgram's API in real-time during recording. See [Deepgram data usage](#deepgram-data-usage) above. |
| Transcripts | Held in the panel session only. Gone when you close STP. |
| Prompts | Sent to Antigravity or Claude Code on your local machine. Not stored by STP. |
| API keys | Stored in VS Code SecretStorage (your OS keychain). Never in a file, never leaves your machine. |
| Claude Code patches | Backups of the original files are kept locally in `.vtp-backups/` next to the patched extension. Restore command rolls them back. |

No telemetry. No analytics. No STP backend.

---

## Codebase Map

A quick map of the source for anyone who wants to contribute, fork, or just understand how it works.

```
src/
  extension.ts                   Entry point — registers the webview provider, commands, and Claude Code auto-patch
  types.ts                       Shared TypeScript interfaces used across modules

  panel/
    VTPPanel.ts                  State machine, UI orchestration, API key management
    CommandDetector.ts           Voice trigger regex patterns (send, enhance, clean, pause, etc.)

  audio/
    AudioCapture.ts              FFmpeg process management — mic capture, PCM chunking
    DeepgramTranscriber.ts       Raw WebSocket client for Deepgram nova-2 streaming

  pipeline/
    IntentProcessor.ts           Classifies each transcript chunk (send / enhance / clean / clear / pause)
    PromptElaborator.ts          Gemini pass that rewrites a rough transcript into a production-ready prompt
    PromptCleaner.ts             Hybrid filler/repetition cleaner — regex first, Gemini only when noisy
    CommandExecutor.ts           Executes resolved intents — triggers enhance, clean-up, or send flows
    ChatInjector.ts              Routes the final prompt to Antigravity or Claude Code based on the active target

  integrations/claudeCode/
    patches.ts                   Hot-patch definitions for Claude Code's extension.js + webview/index.js
    patcher.ts                   Apply / restore lifecycle, schema upgrade detection, backup management
    conversations.ts             Enumerates open Claude chat panels and the conversation lock

  context/
    WorkspaceContextCollector.ts Gathers open files, cursor position, and project structure for context
    ConversationMatcher.ts       Pulls recent Antigravity conversation history to ground the prompt

  commands/
    CommandRegistry.ts           Maps VS Code command IDs to handler functions

  config/
    SecretManager.ts             Wraps VS Code SecretStorage for Gemini and Deepgram API keys

tools/
  patch-claude-code.js           CLI patcher (alternative to the auto-patch on activate)
  unpatch-claude-code.js         CLI restore tool
  claude-code-patch.js           Shared patch definitions used by both the extension and the CLI
```

**Data flow:** Mic audio flows through `AudioCapture` into either Gemini (chunked) or `DeepgramTranscriber` (streamed). Transcripts hit `IntentProcessor` for classification. If the user said "enhance", `PromptElaborator` rewrites it with workspace context. Right before injection, `PromptCleaner` runs the auto-cleanup unless the buffer is already enhanced. The final prompt goes to `ChatInjector`, which dispatches to either Antigravity (via the native command) or Claude Code (via the patched IPC, optionally filtered by the locked conversation title).

---

## License

MIT © 2026 — [View on GitHub](https://github.com/nizzynas/antigravity-extension-v1-VTP)
