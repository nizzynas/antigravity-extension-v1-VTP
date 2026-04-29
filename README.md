# STP — Speech to Prompt

[![LinkedIn](https://img.shields.io/badge/LinkedIn-NVS%20Tech-0A66C2?style=flat&logo=linkedin&logoColor=white)](https://www.linkedin.com/company/nvstech/)

> **Talk to Antigravity. Completely hands-free.**

STP is an Antigravity extension that lets you create prompts by voice and fire them straight into your [Antigravity](https://antigravity.dev) chat. No typing, no copy-paste, no need to press send, you say it out loud. You talk, it listens, you can ask Gemini to clean it up, you can enhance it or you can send it straight away — all without touching the keyboard or mouse.

> After the voice pipeline was working, I used the STP extension to build the rest of the extension — so there are some rough edges, but it works, it's useful, and it's being actively improved.

---

## 🎬 How It Works in Practice

### Basic flow — dictate and send

> *You speak:*
> "Build a staff availability page. Each staff member should be able to set their weekly schedule using a calendar-style UI. Use the existing card styling from the dashboard. **Send the prompt.**" 

STP picks up `send the prompt`, injects your prompt directly into Antigravity chat, no need to press send, and restarts the mic. Done.

---

### Enhance flow — let Gemini polish it first

> *You speak:*
> "I need a modal that pops up when a staff member tries to set their availability but hasn't selected their service category yet. It should block them and prompt them to save their categories first. **Enhance this prompt.**"

Gemini rewrites it into a precise, production-ready spec. You see the enhanced version inline and say:

> *"Approve."* → fires into Antigravity.
> *"Reject."* → restores your original.
> *"Try again."* → Gemini takes another pass.

---

### Clean flow — strip noise before sending

Say something awkward mid-dictation? Someone walked in? No problem:

> *You speak:*
> "Add rate limiting to the API — hold on, hey, yeah I'll be right there — okay where was I — add a 429 response with a Retry-After header. **Clean it up. Send the prompt.**"

`Clean it up` runs Gemini with a strict strip-only pass: fillers, interruptions, and off-topic noise are removed. Your actual intent is preserved. Then `send the prompt` fires it.

---

### Pause and resume — mid-session

> *You speak:*
> "Build a login page with Google OAuth and — **pause.**"

Mic mutes immediately. Buffer is preserved. Later:

> *"Resume."* → mic wakes back up exactly where you left off.

---

## ✨ What's Under the Hood

- 🎙 **FFmpeg + Gemini pipeline** — audio captured locally, denoised, transcribed. No browser dependency, no cloud STT lock-in.
- ⚡ **Optional Deepgram real-time mode** — drops latency from ~5s to ~300ms with a free key. Highly recommended for voice commands. See [Deepgram section](#-deepgram-optional--real-time-transcription) below.
- 🧠 **Gemini enhancement** — say *"enhance this prompt"* and get a polished, context-aware rewrite inline
- 🧹 **Voice cleanup** — say *"clean it up"* to strip filler words, background interruptions, and noise without touching your intent
- ✅ **Approve / Reject / Try Again** — review enhancements with buttons or purely by voice
- 🚀 **Hands-free send** — say *"send it"* or *"send the prompt"* — prompt is injected into Antigravity instantly
- ⏸ **Smart pause/resume** — mic mutes on *"pause"*, wakes on *"resume"* — buffer preserved throughout
- 📎 **Workspace context** — reads your open files, active conversation, and workspace name for smarter enhancements
- 🧩 **Multi-memory context** — layer past Antigravity conversations as supplementary context for even richer elaborations
- 🔑 **Secure key storage** — Gemini API key stored in VS Code SecretStorage, never in code or config files
- 🔇 **Built-in noise suppression** — 3-stage FFmpeg filter chain strips low-frequency rumble before audio reaches Gemini

---

## 🗣 Voice Command Reference

Commands work **mid-sentence** — you don't have to say them alone. Say them naturally as part of your dictation.

| Say | What happens |
|---|---|
| *(just talk)* | Appends to your prompt buffer |
| `send it` / `send the prompt` | **Injects directly into Antigravity — no click, no paste** |
| `enhance this prompt` | Rewrites with Gemini. Approve / Reject / Try Again inline |
| `clean it up` / `scrub that` | Strips filler words and noise — never expands or rewrites |
| `approve` / `reject` / `try again` | Voice-control the enhancement review |
| `pause` / `mute` / `stop listening` | Mutes mic; buffer preserved |
| `resume` / `continue` / `I'm back` | Wakes from pause |
| `clear transcript` / `clear that` | Discards the current buffer — must be said alone |
| `open the terminal` / `run tests` | IDE commands — no prompt involved |

> 💡 Commands are ~10× faster in Deepgram mode (~300ms) vs Gemini chunked mode (~5s).

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

### 3. Add your key to STP

Open the STP panel from the Activity Bar, click **KEY**, and paste your Gemini API key. Stored in VS Code SecretStorage — never in a file, never leaves your machine.

### 4. Start talking

Click the microphone button and start dictating. In Gemini mode, audio processes in 3-second chunks — transcript updates live as you speak.

### 5. (Recommended) Enable Deepgram for real-time transcription

By default STP uses Gemini for transcription (offline, no extra keys, ~4-7s latency). **Enable Deepgram** for ~300ms latency and instant voice command response — it's free and takes 2 minutes.

Click **⚡ LIVE** in the STP panel header and follow the onboarding.

---

## ⚡ Deepgram (Optional) — Real-Time Transcription

Deepgram is an optional, opt-in 3rd-party service that drops transcription latency to ~300ms via real-time streaming. A **free API key** is all you need.

Click the **⚡ LIVE** button in the panel and follow the onboarding. Your key is stored in VS Code SecretStorage and only sent to Deepgram's API during recording.

### Deepgram Data Usage

> Based on publicly available Deepgram documentation (early 2026). See [deepgram.com/privacy](https://deepgram.com/privacy) for the authoritative source.

| Feature | Default | Opt-out |
|---|---|---|
| **Transcription** | Audio sent to Deepgram's API during recording | — |
| **Model training** | May use audio to improve models (50% discount applied) | Add `mip_opt_out=true` to API requests |
| **Data selling** | **No** — Deepgram does not sell your voice data | — |
| **Data retention** | Logs retained ~90 days | Opt-out: deleted after processing |
| **Compliance** | HIPAA, GDPR, CCPA, SOC-2 Type 2, TLS 1.3, AES-256 | — |

👉 [Get a free Deepgram API key](https://console.deepgram.com) | [Privacy policy](https://deepgram.com/privacy)

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
