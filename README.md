# STP — Hands-Free Speech to Prompt

[![Open VSX](https://img.shields.io/open-vsx/v/nizzynas/vtp-voice-prompt?style=flat&label=Open%20VSX&color=C160EF)](https://open-vsx.org/extension/nizzynas/vtp-voice-prompt)
[![License: MIT](https://img.shields.io/badge/License-MIT-gray?style=flat)](LICENSE)

> **Prompt Antigravity. Completely hands-free.**

STP is an Antigravity extension that lets you dictate, enhance, and send prompts into [Antigravity](https://antigravity.dev) by saying **hey antigravity** (default) — start to finish, entirely by voice. No typing, no clicking, no pressing send.  

> After the voice pipeline was working, I used the STP extension to build the rest of the extension — so there are some rough edges, but it works, it's useful, and it's being actively improved.

---

## Watch the Demo

<p align="center">
  <a href="https://www.youtube.com/watch?v=fAC30bak_xY">
    <img src="https://img.youtube.com/vi/fAC30bak_xY/maxresdefault.jpg" alt="STP Hands-Free Demo Video" width="720" />
  </a>
  <br />
  <em>Click to open on YouTube</em>
</p>

## Completely Hands-Free

The full loop — start, dictate, send, repeat — happens entirely by voice. No mouse. No keyboard.

Say your wake phrase and STP starts listening. The default is **"hey antigravity"**. Change it anytime in Settings.

### Two modes

| Mode | What happens after a prompt is sent |
|---|---|
| **Voice Activated** *(default)* | Mic idles. Say your wake phrase to start the next prompt. |
| **Continuous** | Mic auto-restarts immediately. Just keep talking. |

Switch anytime from the Settings menu in the panel.

---

## How It Works in Practice

### Basic flow — dictate and send

> *"**Hey antigravity.** Build a staff availability page. Each staff member sets their weekly schedule with a calendar UI. Use the existing dashboard card styling. **Send the prompt.**"*

STP hears `send the prompt`, injects it into Antigravity, and goes back to listening.

---

### Enhance flow — let Gemini polish it first

> *"**Hey antigravity.** I need a modal that blocks staff from setting availability until they've saved their service category. **Enhance this prompt.**"*

Gemini rewrites it into a precise spec. Review it inline:

> *"Approve."* → fires into Antigravity.  
> *"Reject."* → restores your original.  
> *"Try again."* → Gemini takes another pass.

---

### Clean flow — strip noise before sending

> *"**Hey antigravity.** Add rate limiting to the API — hold on, sorry — add a 429 response with a Retry-After header. **Clean it up. Send the prompt.**"*

`Clean it up` strips fillers and interruptions without touching your intent. Then `send the prompt` fires it.

---

### Pause and resume — mid-session

> *"**Hey antigravity.** Build a login page with Google OAuth and — **pause.**"*

Mic mutes. Buffer preserved. Later:

> *"Resume."* → mic wakes exactly where you left off.

---

## What's Under the Hood

- ![audio](https://img.shields.io/badge/-FFmpeg%20%2B%20Gemini-black?logo=ffmpeg&logoColor=white&style=flat-square) **Audio pipeline** — audio captured locally, denoised, transcribed. No browser dependency, no cloud STT lock-in.
- ![deepgram](https://img.shields.io/badge/-Deepgram%20Real--Time-black?logo=deepgram&logoColor=white&style=flat-square) **Optional real-time mode** — drops latency from ~5s to ~300ms with a free key. Highly recommended for voice commands.
- ![gemini](https://img.shields.io/badge/-Gemini-black?logo=google&logoColor=white&style=flat-square) **Prompt enhancement** — say *"enhance this prompt"* and get a polished, context-aware rewrite inline
- **Voice cleanup** — say *"clean it up"* to strip filler words and noise without touching your intent
- **Approve / Reject / Try Again** — review enhancements with buttons or purely by voice
- **Hands-free send** — say *"send it"* or *"send the prompt"* — injected into Antigravity instantly, no click
- **Smart pause/resume** — mic mutes on *"pause"*, wakes on *"resume"* — buffer preserved throughout
- **Workspace context** — reads your open files, active conversation, and workspace name for smarter enhancements
- **Multi-memory context** — layer past Antigravity conversations as supplementary context for richer elaborations
- ![security](https://img.shields.io/badge/-SecretStorage-black?logo=visualstudiocode&logoColor=white&style=flat-square) **Secure key storage** — Gemini API key stored in VS Code SecretStorage, never in code or config files
- **Built-in noise suppression** — 3-stage FFmpeg filter chain strips low-frequency rumble before audio reaches Gemini

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
| `send it` / `send the prompt` | Injects directly into Antigravity |
| `enhance this prompt` | Gemini rewrites it. Review inline with voice |
| `clean it up` / `scrub that` | Strips filler and noise — never expands or rewrites |
| `approve` / `reject` / `try again` | Controls the enhancement review |

### Pause and resume

| Say | What happens |
|---|---|
| `pause` / `mute` / `stop listening` | Mutes mic immediately; buffer preserved |
| `resume` / `I'm back` | Wakes back up exactly where you left off |
| `pause and pull up [url]` | Pauses and opens the URL in one command |

### Side commands

Say these to trigger actions without touching your prompt buffer.

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

> Commands are ~10x faster in Deepgram mode (~300ms) vs Gemini chunked mode (~5s).

---

## Getting Started

### 1. Install FFmpeg

**Windows (recommended via winget):**
```
winget install ffmpeg
```
Or download from [ffmpeg.org](https://ffmpeg.org/download.html) and add to your system PATH. Restart VS Code after installing.

### 2. Get a Gemini API Key

Get a key at [aistudio.google.com](https://aistudio.google.com/apikey) — **no credit card required**. The free tier (~15 req/min) is enough for normal use.

### 3. Add your key to STP

Open the STP panel from the Activity Bar, click **KEY**, and paste your Gemini API key. Stored in VS Code SecretStorage — never in a file, never leaves your machine.

### 4. Start talking

Click the microphone button and start dictating. In Gemini mode, audio processes in 3-second chunks — transcript updates live as you speak.

### 5. (Recommended) Enable Deepgram for real-time transcription

By default STP uses Gemini for transcription (~4–7s per chunk). Enable Deepgram for ~300ms latency and instant voice command response — it's free and takes 2 minutes.

Click **LIVE** in the STP panel header and follow the onboarding.

---

## Deepgram — Real-Time Transcription (Optional)

Deepgram is an optional, opt-in third-party service that drops transcription latency to ~300ms via real-time streaming. A **free API key** is all you need.

Click the **LIVE** button in the panel and follow the onboarding. Your key is stored in VS Code SecretStorage and only sent to Deepgram's API during recording.

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
| Prompts | Sent to Antigravity on your local machine. Not stored by STP. |
| API keys | Stored in VS Code SecretStorage (your OS keychain). Never in a file, never leaves your machine. |

No telemetry. No analytics. No STP backend.

---

## Under the Hood

A quick map of the codebase for anyone who wants to contribute, fork, or just understand how it works.

```
src/
  extension.ts                   Entry point — registers the webview provider and commands
  types.ts                       Shared TypeScript interfaces used across modules

  panel/
    VTPPanel.ts                  State machine, UI orchestration, API key management

  audio/
    AudioCapture.ts              FFmpeg process management — mic capture, PCM chunking
    DeepgramTranscriber.ts       Raw WebSocket client for Deepgram nova-2 streaming

  pipeline/
    IntentProcessor.ts           Classifies each transcript chunk (send / enhance / clean / clear / pause)
    PromptElaborator.ts          Gemini pass that rewrites a rough transcript into a production-ready prompt
    CommandExecutor.ts           Executes resolved intents — triggers enhance, clean-up, or send flows
    ChatInjector.ts              Finds the Antigravity chat input, pastes the final prompt, and submits it

  context/
    WorkspaceContextCollector.ts Gathers open files, cursor position, and project structure for context
    ConversationMatcher.ts       Pulls recent Antigravity conversation history to ground the prompt

  commands/
    CommandRegistry.ts           Maps VS Code command IDs to handler functions

  config/
    SecretManager.ts             Wraps VS Code SecretStorage for Gemini and Deepgram API keys
```

**Data flow:** Mic audio flows through `AudioCapture` into either Gemini (chunked) or `DeepgramTranscriber` (streamed). Transcripts are classified by `IntentProcessor`. If the user says "enhance", `PromptElaborator` rewrites the transcript using workspace context from `WorkspaceContextCollector` and conversation history from `ConversationMatcher`. The final prompt is handed to `ChatInjector`, which locates the Antigravity chat panel and submits it.

---

## License

MIT © 2026 — [View on GitHub](https://github.com/nizzynas/antigravity-extension-v1-VTP)
