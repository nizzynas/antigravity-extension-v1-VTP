# Changelog

All notable changes to VTP — Voice to Prompt are documented here.

---

## [0.1.17] — 2026-04-28
### Added
- **Deepgram real-time transcription engine** — optional, opt-in streaming pipeline using Deepgram nova-2. Reduces transcription latency from ~5s to ~300ms. Requires a __FREE__ Deepgram API key stored locally in VS Code SecretStorage.
- **⚡ LIVE button** — new header button to enable/disable Deepgram. Clicking opens a guided disclosure + key onboarding flow (data usage, privacy policy, opt-out info). Active state shown with amber glow when Deepgram is running.
- **Instant voice commands in Deepgram mode** — "send it", "enhance this prompt" etc. are detected on every Deepgram final word result (~300ms) rather than waiting for 3s chunk boundaries.
- **Graceful fallback** — if Deepgram engine is set but no key is found, automatically falls back to Gemini chunked mode with a log warning.
- **`vtp.transcriptionEngine` setting** — `gemini` (default) or `deepgram`. Persists across restarts.

### Changed
- `startRecording` / `stopRecording` now branch on the selected engine, keeping both pipelines cleanly separated.
- Wake monitor "waiting for speech" log now fires only once per sleep cycle (no more spam).

---

## [0.1.16] — 2026-04-28
### Added
- **Multi-memory context picker** — click the 📂 context card in the panel to open a multi-select list of all past Antigravity conversations. Check any number of past chats to layer them as supplementary read-only context on top of the auto-detected primary.
- **Additive extra context** — extras are appended to the primary conversation's messages when Gemini elaborates a prompt. They cannot be edited, just added or removed — keeping the primary context clean.
- **`+N` badge** — when extra conversations are active, a small purple pill showing the count (e.g. `+2`) appears on the context card so you always know how many memory layers are active.
- **Extras persist per session** — the extra stack stays loaded for the lifetime of the panel; clicking the card again opens the picker with the same selections pre-checked so you can add/remove incrementally.

### Fixed
- **Primary context now uses recency** — `findBestMatch()` now selects the most recently modified conversation log (= the chat you're currently in Antigravity) instead of a scoring heuristic that caused all workspace chats to rank identically and show stale context.

---

## [0.1.15] — 2026-04-28
### Fixed
- **Trigger recovery on timeout** — if a chunk's Gemini call times out (10s), the accumulated `interimTranscript` is immediately scanned for send/enhance triggers so commands aren't silently dropped when the API is slow on that specific chunk
- **Chunk timeout bumped to 10s** — reduces false drops on "send the prompt" chunks that take 6–9s under moderate API load while still capping worst-case stalls (was 6s, was 30s before 0.1.14)
### Changed
- Extension description updated to lead with Antigravity rather than VS Code

---

## [0.1.14] — 2026-04-28
### Fixed
- **Queue stall (45s freeze bug)** — each live chunk's Gemini call now has a hard 6-second timeout via `Promise.race`; a hung API call no longer freezes the entire transcription queue
- **Queue depth monitoring** — logs `⚠ Queue backed up (N pending)` when more than 3 chunks are waiting, making API slowdowns immediately visible in the VTP output panel

---

## [0.1.13] — 2026-04-28
### Fixed
- **Send trigger reliability** — chunk window reduced from 3s to 2s so "send the prompt" fits cleanly in a single transcription window rather than straddling chunk boundaries
- **Per-chunk trigger check** — send trigger now fires on each incoming chunk in isolation (not just accumulated text), so a first clean utterance fires immediately even if prior chunks were garbled by Gemini

---

## [0.1.12] — 2026-04-28
### Added
- **Extension icon** — VTP now has a proper icon in the VS Code activity bar, extensions panel, and marketplace listing

### Fixed
- **Enhance trigger latency** — "enhance this prompt" now mutes the mic instantly (same `capture.kill()` fast-path as "send the prompt"), cutting 3–4s of VAD silence wait + Gemini classification round-trip
- **Voice approval robustness** — fuzzy match catches "prove" (chunk-boundary fragment of "approve"); non-decision speech during review is now discarded instead of silently polluting the prompt buffer; `interimTranscript` cleared after decision fires to prevent post-approval speech leaking into buffer
- **Approval UI feedback** — status bar pulses "Say: approve, reject, or try again" when unrecognized speech arrives during enhancement review

---

## [0.1.11] — 2026-04-28
### Changed
- **Chunk duration 1s → 3s** — longer windows give Gemini full sentence context, virtually eliminating transcription hallucination
- **VAD threshold 2.5s → 1.5s** — faster send-trigger response time

### Added
- **Noise suppression pipeline** — mandatory FFmpeg pre-processing chain: `highpass=f=80` (rumble removal) → `afftdn=nf=-25:nt=w` (FFT denoising) → `silencedetect`
- **Tail-scan trigger recovery** — `onFinalTranscript` scans the last 120 characters for a split send trigger, ensuring triggers are captured across chunk boundaries
- **Wake monitor hardening** — synchronized wake-monitor filters with main chain; reduced wake-monitor VAD to 0.5s; `onSilenceStart` wired as secondary resume trigger
- **VTT/SRT artifact sanitizer** — strips residual timestamp tokens (e.g. `00:00`) that leaked into the transcript buffer

---

## [0.1.10] — 2026-04-28
### Changed
- Removed dual-engine (Web Speech API + FFmpeg) architecture — FFmpeg + Gemini is now the sole transcription pipeline
- Updated README to reflect FFmpeg-only architecture

---

## [0.1.9] — 2026-04-28
### Added
- Continuous listening — after VAD auto-stop, recording automatically restarts for uninterrupted dictation
- Smart auto-pause with wake monitor — extended silence triggers auto-pause; say "resume", "continue", or "I'm back" to restart
- Local send trigger detection — "send the prompt" / "send it" handled locally without Gemini classification round-trip

### Fixed
- FFmpeg process zombie prevention — serialized stop/start logic eliminates resource contention on the DirectShow mic device
- RMS energy gate — silent/noise-only audio discarded before API submission

---

## [0.1.0] — 2026-04-28
### Added
- Initial release
- FFmpeg audio capture with chunked live transcription via Gemini
- Gemini prompt enhancement with approve / reject / try again flow
- Workspace context injection (open files, active conversation, workspace name)
- Secure API key storage via VS Code SecretStorage
- Voice commands: pause, resume, send, clear, enhance
