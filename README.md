# VTP — Voice to Prompt

> **Voice-driven AI coding. Dictate. Enhance. Send. Completely hands-free.**

VTP turns your voice into a full AI coding workflow. Click once to start recording, then speak your idea — Gemini shapes it into a production-ready prompt and fires it straight into your prompts window in [Antigravity](https://antigravity.dev). Dictate, enhance, send: all by voice, no keyboard required once you're rolling.

> **⚠️ Heads up:** This extension is pretty vibe-coded. After the voice pipeline was working, I started using VTP itself to build the rest of it — so there are rough edges but it works, it's useful, and it's being actively improved.

---

## ✨ Features

- 🎙 **Live transcription** — FFmpeg-powered audio capture with real-time streaming to Gemini, no browser mic permission required
- 🧠 **Gemini enhancement** — say *"enhance this prompt"* and get a polished, context-aware rewrite inline
- ✅ **Approve / Reject / Try Again** — review enhancements with buttons or purely by voice
- 🚀 **Hands-free send** — say *"send it"* and your prompt is injected into Antigravity instantly. No clicking, no copy-paste, nothing.
- ⚡ **Full voice control** — pause, resume, send, clear, enhance — all without touching the mouse
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

Get a key at [aistudio.google.com](https://aistudio.google.com/apikey) — **no credit card required**. Use the free tier (~15 req/min) or a pay-as-you-go plan for higher limits.

### 3. Add your key to VTP

Open the VTP panel from the Activity Bar, click **KEY**, and paste your Gemini API key. It's stored in VS Code SecretStorage (your OS credential manager) — never in a file, never leaves your machine.

### 4. Start talking

Click the microphone button (or enable VAD for always-on mode) and start dictating.

---

## 🗣 Voice Command Reference

| Say | What happens |
|---|---|
| *(just talk)* | Appends to your prompt buffer |
| `send it` / `send the prompt` | **Injects directly into Antigravity — hands-free, no click, no paste** |
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

## 🔒 Privacy

VTP does not collect, store, or transmit any personal data.

| What | Where it goes |
|---|---|
| 🎙 Audio | Captured in-memory, sent to Gemini for transcription, then discarded. Never written to disk. |
| 📝 Transcripts | Held in the panel session only. Gone when you close VTP. |
| 💬 Prompts | Sent to Antigravity on your local machine. Not stored by VTP. |
| 🔑 API key | Stored in VS Code SecretStorage (your OS keychain). Never in a file, never leaves your machine. |

No telemetry. No analytics. No backend.

---

## 📄 License

MIT © 2026 — [View on GitHub](https://github.com/nizzynas/antigravity-extension-v1-VTP)
