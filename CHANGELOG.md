# Changelog

All notable changes to STP — Speech to Prompt are documented here.

---

## [0.1.26] — 2026-04-29
### Fixed
- **Wake phrase not reflected in examples** — "hey antigravity" spans in the voice command examples now dynamically update to the user's configured phrase.
- **Screen 3 references removed button** — subtitle now correctly points to ⚙ Settings instead of the old CONT/WAKE toggle.
- **Voice Activated description** — now mentions "resume" / "I'm back" as pause-resume triggers.

### Added
- **Extension keywords** — `voice`, `speech`, `antigravity`, `dictation`, `hands-free`, `speech to prompt`, etc. — makes the extension discoverable in marketplace searches.

---

## [0.1.25] — 2026-04-29
### Fixed
- **Transcript wiped after pause/resume** — text spoken before saying "pause" in Deepgram mode was being discarded. `onFinalTranscript` now strips the pause keyword and saves the remaining pre-pause content to the prompt buffer before entering monitor mode.
- **Wake monitor missed "resume" ~50 consecutive times** — the Deepgram wake monitor was using a batch HTTP poll loop (1.5s capture windows). Words spoken between windows were simply never heard. Replaced with the same live streaming WebSocket pipeline used for normal dictation — every utterance is now transcribed with <300ms latency, same as regular recording.

- **Onboarding wizard** — first-run overlay walks new users through engine selection, API key entry, and post-send flow mode in three guided steps.
- **Engine picker** — dropdown in the header to switch between Gemini and Deepgram engines with a "Manage API Keys" shortcut.
- **Post-send flow setting** — choose between Continuous (mic auto-restarts) or Voice Activated (mic idles, wake phrase to restart).
- **Wake phrase activation** — say your custom wake phrase (default: "hey antigravity") to start a session without clicking.
- **Pause & Resume voice commands** — say "pause" to mute mid-sentence, say "resume" / "continue" / "I'm back" to wake back up. Buffer is preserved throughout.

### Fixed
- **Duplicate `checkForWakePhrase()` calls** — wake monitor was being launched twice on voice-triggered pause, causing a race condition.

---

## [0.1.23] — 2026-04-29
### Added
- **Deepgram streaming wake monitor** — when Deepgram is the active engine, the wake monitor now uses a persistent streaming WebSocket instead of the batch poll loop, giving sub-300ms wake detection latency.

### Fixed
- **Transcript state lost on pause** — `interimTranscript` content is now preserved in `promptBuffer` before the wake monitor starts, and re-rendered after resume.

---

## [0.1.22] — 2026-04-29
### Added
- **Side commands** — say voice commands like "open the terminal", "run tests", or any URL while dictating; they execute via Antigravity's MCP tools without interrupting your prompt buffer.
- **Pause + side command compound** — "Pause and open github.com" pauses the mic and fires the side command in one utterance.
- **"Clean it up" / "scrub that" commands** — strip filler words and off-topic noise via a constrained Gemini pass. Never expands or rewrites.

### Fixed
- **`checkForWakePhrase` double-call** — wake monitor was launched from both `onFinalTranscript` and `stopRecording` on the same pause event.

---

## [0.1.21] — 2026-04-29
### Changed
- **README overhaul** — replaced vague feature list opener with four concrete workflow examples: basic dictate+send, enhance+approve, clean-up mid-sentence noise, and pause+resume. Gives new users an immediate sense of how it actually feels to use STP.
- **Updated extension description** — more direct: *"Dictate coding prompts by voice, clean them up, enhance with Gemini, and fire them straight into Antigravity."*
- **Voice command table** — now includes `clean it up`/`scrub that`, `mute`, clarifies that `clear that` must be said alone, and notes the ~10× speed difference between Deepgram and Gemini modes.

---

## [0.1.20] — 2026-04-29
### Fixed
- **"Clear that" wiping mid-sentence dictation** — the clear command regex in Gemini chunked mode was unanchored (`\b` match), so saying "Clear that. Perfect. Okay. So for availabilities..." as part of a long dictation would wipe the entire buffer when the final transcript was assembled. Regex is now anchored (`^...$`) — the entire segment must be the clear command, matching the Deepgram mode behaviour.

---

## [0.1.19] — 2026-04-29
### Added
- **"Clean it up" / "scrub that" voice command** — strips filler words, profanity, and off-topic noise from the buffer via a tightly constrained Gemini pass. Never expands or rewrites — only removes. Works in both Gemini chunked and Deepgram streaming modes.
- **Voice command reference updated** — panel glossary now lists `pause`, `mute`, `stop listening`, `clean it up`, `scrub that`, and includes a note that commands fire ~10x faster in Deepgram mode.

### Fixed
- **Resume after voice pause** — saying "pause" in Deepgram mode no longer leaves the mic stuck with no way to resume. The wake monitor now launches correctly after any voice-triggered pause (not just VAD auto-pauses).
- **Infinite "Processing…" on manual stop** — clicking stop in Deepgram mode with an empty buffer no longer leaves the UI spinning forever. A `transcriptResult` flush is sent to settle the panel back to idle.

---

## [0.1.18] — 2026-04-29
### Added
- **Deepgram real-time transcription engine** — optional, opt-in streaming pipeline using Deepgram nova-2. Reduces transcription latency from ~5s to ~300ms. Requires a free Deepgram API key stored locally in VS Code SecretStorage.
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
- **Multi-memory context picker** — click the context card to open a multi-select list of all past Antigravity conversations. Check any number of past chats to layer them as supplementary read-only context.
- **Additive extra context** — extras are appended to the primary conversation when Gemini elaborates a prompt. They cannot be edited, just added or removed.
- **`+N` badge** — when extra conversations are active, a small purple pill shows the count on the context card.
- **Extras persist per session** — the extra stack stays loaded for the lifetime of the panel.

### Fixed
- **Primary context now uses recency** — `findBestMatch()` now selects the most recently modified conversation log instead of a scoring heuristic that caused all workspace chats to rank identically.

---

## [0.1.15] — 2026-04-28
### Fixed
- **Trigger recovery on timeout** — if a chunk's Gemini call times out (10s), the accumulated `interimTranscript` is immediately scanned for send/enhance triggers so commands aren't silently dropped.
- **Chunk timeout bumped to 10s** — reduces false drops on "send the prompt" chunks that take 6–9s under moderate API load (was 6s).

### Changed
- Extension description updated to lead with Antigravity rather than VS Code.

---

## [0.1.14] — 2026-04-28
### Fixed
- **Queue stall (45s freeze bug)** — each live chunk's Gemini call now has a hard 6-second timeout via `Promise.race`; a hung API call no longer freezes the entire transcription queue.
- **Queue depth monitoring** — logs `⚠ Queue backed up (N pending)` when more than 3 chunks are waiting.

---

## [0.1.13] — 2026-04-28
### Fixed
- **Send trigger reliability** — chunk window reduced from 3s to 2s so "send the prompt" fits cleanly in a single transcription window.
- **Per-chunk trigger check** — send trigger now fires on each incoming chunk in isolation, so a first clean utterance fires immediately even if prior chunks were garbled.

---

## [0.1.12] — 2026-04-28
### Added
- **Extension icon** — STP now has a proper icon in the VS Code activity bar, extensions panel, and marketplace listing.

### Fixed
- **Enhance trigger latency** — "enhance this prompt" now mutes the mic instantly, cutting 3–4s of VAD silence wait.
- **Voice approval robustness** — fuzzy match catches "prove" (fragment of "approve"); non-decision speech during review is discarded; `interimTranscript` cleared after decision fires.
- **Approval UI feedback** — status bar pulses "Say: approve, reject, or try again" when unrecognized speech arrives during enhancement review.

---

## [0.1.11] — 2026-04-28
### Changed
- **Chunk duration 1s → 3s** — longer windows give Gemini full sentence context, virtually eliminating transcription hallucination.
- **VAD threshold 2.5s → 1.5s** — faster send-trigger response time.

### Added
- **Noise suppression pipeline** — mandatory FFmpeg pre-processing: `highpass=f=80` → `afftdn=nf=-25:nt=w` → `silencedetect`.
- **Tail-scan trigger recovery** — `onFinalTranscript` scans the last 120 characters for a split send trigger.
- **Wake monitor hardening** — synchronized wake-monitor filters with main chain; reduced wake-monitor VAD to 0.5s.
- **VTT/SRT artifact sanitizer** — strips residual timestamp tokens that leaked into the transcript buffer.

---

## [0.1.10] — 2026-04-28
### Changed
- Removed dual-engine (Web Speech API + FFmpeg) architecture — FFmpeg + Gemini is now the sole transcription pipeline.
- Updated README to reflect FFmpeg-only architecture.

---

## [0.1.9] — 2026-04-28
### Added
- **Continuous listening** — after VAD auto-stop, recording automatically restarts for uninterrupted dictation.
- **Smart auto-pause with wake monitor** — extended silence triggers auto-pause; say "resume", "continue", or "I'm back" to restart.
- **Local send trigger detection** — "send the prompt" / "send it" handled locally without a Gemini classification round-trip.

### Fixed
- **FFmpeg process zombie prevention** — serialized stop/start logic eliminates resource contention on the DirectShow mic device.
- **RMS energy gate** — silent/noise-only audio discarded before API submission.

---

## [0.1.0] — 2026-04-28
### Added
- Initial release
- FFmpeg audio capture with chunked live transcription via Gemini
- Gemini prompt enhancement with approve / reject / try again flow
- Workspace context injection (open files, active conversation, workspace name)
- Secure API key storage via VS Code SecretStorage
- Voice commands: pause, resume, send, clear, enhance
