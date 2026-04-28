# VTP — Voice to Prompt

> **Voice-driven AI coding. Dictate. Enhance. Send. Completely hands-free.**

VTP turns your voice into a full AI coding workflow. Click once to start recording, then speak your idea — Gemini shapes it into a production-ready prompt and fires it straight into your prompts window in [Antigravity](https://antigravity.dev). Dictate, enhance, send: all by voice, no keyboard required once you're rolling.

> **⚠️ Heads up:** This extension is pretty vibe-coded. After the voice pipeline was working, I started using VTP itself to build the rest of it — so there are rough edges but it works, it's useful, and it's being actively improved.

---

## ✨ Features

- 🎙 **FFmpeg + Gemini pipeline** — audio is captured locally by FFmpeg, denoised, and transcribed by Gemini. No browser dependency, no cloud STT lock-in.
- 🔇 **Built-in noise suppression** — a 3-stage FFmpeg filter chain (`highpass → afftdn → silencedetect`) strips low-frequency rumble and PC background noise before audio ever reaches Gemini.
- 🧠 **Gemini enhancement** — say *"enhance this prompt"* and get a polished, context-aware rewrite inline
- ✅ **Approve / Reject / Try Again** — review enhancements with buttons or purely by voice
- 🚀 **Hands-free send** — say *"send it"* or *"send the prompt"* and your prompt is injected into Antigravity instantly. No clicking, no copy-paste, nothing.
- ⏸ **Smart auto-pause** — silence detection auto-pauses after you stop talking, then restarts automatically for continuous listening
- ⚡ **Full voice control** — pause, resume, send, clear, enhance — all without touching the mouse
- 📎 **Workspace context** — automatically reads your open files, active conversation, and workspace name for smarter prompts
- 🔑 **Secure key storage** — Gemini API key stored in VS Code SecretStorage, never in code or config files

---

## 🚀 Getting Started

### 1. Install FFmpeg

**Windows (recommended via winget):**
```
winget install ffmpeg
```

Or download from [ffmpeg.org](https://ffmpeg.org/download.html) and add to your system PATH. Restart VS Code after installing.

### 2. Get a Gemini API Key

Get a key at [aistudio.google.com](https://aistudio.google.com/apikey) — **no credit card required**. The free tier (~15 req/min) is enough for normal use.

### 3. Add your key to VTP

Open the VTP panel from the Activity Bar, click **KEY**, and paste your Gemini API key. It's stored in VS Code SecretStorage (your OS credential manager) — never in a file, never leaves your machine.

### 4. Start talking

Click the microphone button and start dictating. Audio processes in 3-second chunks — so you'll see the transcript update every few seconds as you speak.

---

## 🗣 Voice Command Reference

| Say | What happens |
|---|---|
| *(just talk)* | Appends to your prompt buffer |
| `send it` / `send the prompt` | **Injects directly into Antigravity — hands-free, no click, no paste** |
| `enhance this prompt` | Rewrites with Gemini. Approve / Reject / Try Again inline |
| `approve` / `reject` / `try again` | Voice-control the enhancement review |
| `pause` / `stop listening` | Mutes mic; already-spoken speech finishes processing first |
| `resume` / `continue` / `I'm back` | Wakes from pause |
| `clear transcript` / `clear that` | Discards the current transcript buffer |
| `open the terminal` / `run tests` | IDE commands — runs without touching the prompt |

---

## 🖥 Platform Support

| Platform | Status |
|---|---|
| **Windows** | ✅ Fully supported (DirectShow via FFmpeg) |
| macOS | 🔜 Planned (AVFoundation) |
| Linux | 🔜 Planned (ALSA) |

---

## ⚙️ Settings

| Setting | Default | Description |
|---|---|---|
| `vtp.vadMode` | `false` | Always-on VAD — auto-pauses after silence, restarts automatically |
| `vtp.contextDepth` | `20` | Recent conversation messages passed as context to Gemini |
| `vtp.elaborationModel` | `gemini-2.5-flash` | Gemini model used for prompt enhancement |

---

## 🔧 How the Audio Pipeline Works

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
3. **`silencedetect=noise=-40dB:d=2.5`** — triggers VAD after 2.5s of true silence (on the *cleaned* signal)
4. Audio is segmented into **3-second WAV chunks** and sent to Gemini for verbatim transcription
5. Each chunk's transcript is appended live to the panel as it comes back

---

## 🛠 Built With

- [VS Code Extension API](https://code.visualstudio.com/api)
- [Google Gemini API](https://ai.google.dev/) — transcription, intent classification + prompt enhancement
- [FFmpeg](https://ffmpeg.org/) — audio capture, noise suppression, VAD
- Vibe coded with [Antigravity](https://antigravity.dev) 🤙

---

## 🔒 Privacy

VTP does not collect, store, or transmit any personal data.

| What | Where it goes |
|---|---|
| 🎙 Audio | Captured locally by FFmpeg, sent to Gemini for transcription, then discarded. Never written to disk permanently. |
| 📝 Transcripts | Held in the panel session only. Gone when you close VTP. |
| 💬 Prompts | Sent to Antigravity on your local machine. Not stored by VTP. |
| 🔑 API key | Stored in VS Code SecretStorage (your OS keychain). Never in a file, never leaves your machine. |

No telemetry. No analytics. No backend.

---

## 📄 License

MIT © 2026 — [View on GitHub](https://github.com/nizzynas/antigravity-extension-v1-VTP)
