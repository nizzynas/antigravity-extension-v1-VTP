# VTP — Voice to Prompt

> **Speak your ideas. Enhance with Gemini. Inject into Antigravity.**

VTP is a real-time voice-to-prompt coding assistant for VS Code. Dictate your thoughts hands-free, let Gemini elaborate them into production-ready prompts, then send them directly into [Antigravity](https://antigravity.dev) — no copy-paste required.

---

## ✨ Features

- 🎙 **Live transcription** — FFmpeg-powered audio capture with real-time streaming to Gemini, no browser mic permission required
- 🧠 **Gemini enhancement** — say *"enhance this prompt"* and get a polished, context-aware rewrite inline
- ✅ **Approve / Reject / Try Again** — review enhancements with buttons or purely by voice
- ⚡ **Voice commands** — pause, resume, send, clear, enhance — all hands-free. Say "pause" mid-paragraph and everything you already said is still captured.
- 📎 **Workspace context** — automatically reads your open files, active conversation, and workspace name for smarter prompts
- 🔑 **Secure key storage** — Gemini API key stored in VS Code SecretStorage, never in code or config files

---

## 🖥 Platform Support

| Platform | Status |
|---|---|
| **Windows** | ✅ Fully supported (FFmpeg via dshow) |
| macOS | 🔜 Planned (avfoundation backend) |
| Linux | 🔜 Planned (pulse/alsa backend) |

> FFmpeg must be installed and available on your system PATH.

---

## 🚀 Getting Started

### 1. Install FFmpeg

**Windows (recommended via winget):**
```
winget install ffmpeg
```

Or download from [ffmpeg.org](https://ffmpeg.org/download.html) and add to PATH.

### 2. Get a Gemini API Key

Get a free key at [aistudio.google.com](https://aistudio.google.com/apikey).

### 3. Add your key to VTP

Open the VTP panel from the Activity Bar, click **KEY**, and paste your Gemini API key.

### 4. Start talking

Click the microphone button (or enable VAD for always-on mode) and start dictating.

---

## 🗣 Voice Command Reference

| Say | What happens |
|---|---|
| *(just talk)* | Appends to your prompt buffer |
| `send it` / `send the prompt` | Injects directly into Antigravity — no paste needed |
| `enhance this prompt` | Rewrites with Gemini. Approve / Reject / Try Again inline |
| `approve` / `reject` / `try again` | Voice-control the enhancement review |
| `pause` / `stop listening` | Mutes mic immediately; already-queued speech drains first |
| `resume` / `continue` / `I'm back` | Wakes from pause |
| `cancel` / `clear that` | Discards the current transcript buffer |
| `open the terminal` / `run tests` | IDE commands — runs without touching the prompt |

---

## ⚙️ Settings

| Setting | Default | Description |
|---|---|---|
| `vtp.vadMode` | `false` | Always-on voice activity detection |
| `vtp.language` | `en-US` | Speech recognition language (BCP-47) |
| `vtp.contextDepth` | `20` | Recent conversation messages passed as context |
| `vtp.elaborationModel` | `gemini-2.5-flash` | Gemini model used for prompt enhancement |

---

## 🛠 Built With

- [VS Code Extension API](https://code.visualstudio.com/api)
- [Google Gemini API](https://ai.google.dev/) — transcription + enhancement
- [FFmpeg](https://ffmpeg.org/) — low-latency audio capture
- Vibe coded with [Antigravity](https://antigravity.dev) 🤙

---

## 📄 License

MIT © 2026 — [View on GitHub](https://github.com/banko-dev/vtp-voice-prompt)
