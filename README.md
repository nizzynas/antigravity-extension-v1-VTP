# VTP — Voice to Prompt

> **Voice-driven AI coding. Dictate. Enhance. Send. Completely hands-free.**

VTP turns your voice into a full AI coding workflow. Click once to start recording, then speak your idea — Gemini shapes it into a production-ready prompt and fires it straight into your prompts window in [Antigravity](https://antigravity.dev). Dictate, enhance, send: all by voice, no keyboard required once you're rolling.

> **⚠️ Heads up:** This extension is pretty vibe-coded. After the voice pipeline was working, I started using VTP itself to build the rest of it — so there are rough edges but it works, it's useful, and it's being actively improved.

---

## ✨ Features

- 🎙 **FFmpeg + Gemini pipeline** — audio is captured locally by FFmpeg, denoised, and transcribed by Gemini. No browser dependency, no cloud STT lock-in.
- ⚡ **Optional Deepgram real-time mode** — drop latency from ~5s to ~300ms with a free Deepgram API key. Completely opt-in. See [Deepgram section](#-deepgram-optional--real-time-transcription) below.
- 🔇 **Built-in noise suppression** — a 3-stage FFmpeg filter chain (`highpass → afftdn → silencedetect`) strips low-frequency rumble and PC background noise before audio ever reaches Gemini.
- 🧠 **Gemini enhancement** — say *"enhance this prompt"* and get a polished, context-aware rewrite inline
- ✅ **Approve / Reject / Try Again** — review enhancements with buttons or purely by voice
- 🚀 **Hands-free send** — say *"send it"* or *"send the prompt"* and your prompt is injected into Antigravity instantly. No clicking, no copy-paste, nothing.
- ⏸ **Smart auto-pause** — silence detection auto-pauses after you stop talking, then restarts automatically for continuous listening
- ⚡ **Full voice control** — pause, resume, send, clear, enhance — all without touching the mouse
- 📎 **Workspace context** — automatically reads your open files, active conversation, and workspace name for smarter prompts
- 🧩 **Multi-memory context** — layer additional past Antigravity conversations on top of the auto-detected primary. Add or remove extras at any time; they feed into enhancements as read-only supplementary context.
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

### 5. (Recommended) Enable Deepgram for real-time transcription

By default VTP uses Gemini for transcription, which works offline but has ~4-7s chunk latency. **We recommend enabling Deepgram** — it's free, takes 2 minutes to set up, and drops latency to ~300ms so voice commands feel instant.

Click the **⚡ LIVE** button in the VTP panel header and follow the onboarding. Totally up to you — Gemini mode works fine if you'd rather keep everything local and free of third-party services.

---

## ⚡ Deepgram (Optional) — Real-Time Transcription

By default, VTP uses **FFmpeg + Gemini** for transcription. This works offline (no extra keys) but has ~4-7s of latency per chunk.

**Deepgram** is an optional, opt-in 3rd-party service that reduces this to ~300ms with real-time streaming. A **free API key is all you need** — no credit card required.

To enable it: click the **⚡ LIVE** button in the VTP panel and follow the onboarding flow. Your key is stored in VS Code SecretStorage and is never sent anywhere except Deepgram's API during recording.

### Deepgram Data Usage

> Based on publicly available Deepgram documentation and user discussions (early 2026). See [deepgram.com/privacy](https://deepgram.com/privacy) for the authoritative source.

| Feature | Default | Opt-out |
|---|---|---|
| **Transcription** | Audio sent to Deepgram's API during recording | — |
| **Model training** | Deepgram may use your audio to improve their models (50% discount applied) | Add `mip_opt_out=true` to API requests (discount removed) |
| **Data selling** | **No** — Deepgram does not sell your voice data | — |
| **Data retention** | Logs retained ~90 days | Opt-out: data deleted after processing |
| **Compliance** | HIPAA, GDPR, CCPA, SOC-2 Type 2, TLS 1.3, AES-256 | — |

**Key points:**
- Deepgram does **not** sell your voice data to third parties
- You own your data — it's processed under their service agreement
- The free tier is sufficient for VTP usage
- For maximum privacy: opt out of model improvement by setting `mip_opt_out=true` (you'll lose the 50% model-improvement discount, but the free tier is unaffected)
- Enterprise users can use on-premises or VPC deployment to keep data within their own infrastructure

👉 [Get a free Deepgram API key](https://console.deepgram.com) | [Privacy policy](https://deepgram.com/privacy)

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

## 🧩 Memory Context — Multi-Conversation Selection

VTP automatically detects your **current Antigravity conversation** (the most recently modified chat) and feeds it into every enhancement as the primary context.

If you need to pull in knowledge from *other* past chats — a previous session on the same project, a different workspace's conversation — click the **📂 context card** at the top of the panel.

### How it works

| What | How |
|---|---|
| **Primary context** | Auto-detected (most recently modified conversation). Always active. |
| **Extra context** | Past Antigravity conversations you manually check in the picker. |
| **Adding extras** | Click 📂 → tick checkboxes → press Enter. Multiple selections OK. |
| **Removing extras** | Click 📂 again → untick → press Enter. |
| **Effect** | Extra messages are appended (read-only) to the primary context when Gemini elaborates your prompt. |
| **Badge** | A purple `+N` pill appears on the card when extras are active. |

Extras are **read-only** — they inform the elaboration but cannot be modified or replace the primary auto-detected chat.

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
| `vtp.transcriptionEngine` | `gemini` | `gemini` (default, offline-capable) or `deepgram` (real-time, requires key) |

---

## 🔧 How the Audio Pipeline Works

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
3. **`silencedetect=noise=-40dB:d=2.5`** — triggers VAD after 2.5s of true silence (on the *cleaned* signal)
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

## 🛠 Built With

- [VS Code Extension API](https://code.visualstudio.com/api)
- [Google Gemini API](https://ai.google.dev/) — transcription, intent classification + prompt enhancement
- [FFmpeg](https://ffmpeg.org/) — audio capture, noise suppression, VAD
- [Deepgram](https://deepgram.com/) — optional real-time streaming transcription
- Vibe coded with [Antigravity](https://antigravity.dev) 🤙

---

## 🔒 Privacy

VTP does not collect, store, or transmit any personal data.

| What | Where it goes |
|---|---|
| 🎙 Audio (Gemini mode) | Captured locally by FFmpeg, sent to Gemini for transcription, then discarded. Never written to disk permanently. |
| 🎙 Audio (Deepgram mode) | Streamed to Deepgram's API in real-time during recording. See [Deepgram data usage](#deepgram-data-usage) above. |
| 📝 Transcripts | Held in the panel session only. Gone when you close VTP. |
| 💬 Prompts | Sent to Antigravity on your local machine. Not stored by VTP. |
| 🔑 API keys | Stored in VS Code SecretStorage (your OS keychain). Never in a file, never leaves your machine. |

No telemetry. No analytics. No VTP backend.

---

## 📄 License

MIT © 2026 — [View on GitHub](https://github.com/nizzynas/antigravity-extension-v1-VTP)
