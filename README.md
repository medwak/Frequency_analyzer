# Frequency Analyzer

A mobile app that measures the **frequency, wavelength and pitch** of any sound — a hum, a
whistle, a single vowel — live from the microphone, and analyses whole **music files**,
splitting them into a **vocal part** and an **instrumental part** and analysing each one.

All processing runs on the phone. No audio is uploaded anywhere.

## Features

### Live (microphone)
- **Frequency** of the sound's fundamental (YIN pitch detection), updated in real time
- **Musical note** and how many cents sharp/flat, with a tuner needle
- **Wavelength** (speed of sound ÷ frequency, adjusted for air temperature) and **period**
- **Spectrum** with the fundamental and harmonics marked, and the loudest frequency
- **Pitch-over-time** graph with lowest / average / highest pitch for the session
- **Vowel detection**: formants F1, F2 and F3 (from LPC analysis) placed on a vowel chart, with
  the closest vowel (ee, ay, eh, ah, uh, aw, oh, oo)
- **Harmonic strengths** (f₀, 2×, 3×, …)
- **Hold** to freeze the readings; **Rec** records a clip of up to 30 s and runs the full analysis on it

### Music & files
Open an MP3, WAV, M4A/AAC, OGG or FLAC file (anything the phone's browser can decode).
- **Vocal / instrumental separation**: listen to the full mix, the vocals alone or the
  instrumental alone, and save any of them as WAV
- **Vocals**: typical pitch and note, range (lowest–highest note, in octaves), likely voice
  type, wavelength, how much of the track has singing, and the melody as a pitch contour
- **Instrumental**: tempo (BPM), musical key, how much is pitched vs percussive, and a
  short description of the instrument profile (bass weight, mid-range, cymbals and so on)
- **Overall sound**: fundamental, note, wavelength, period, loudest frequency, harmonics, vowel
- **Spectrogram** of the mix, vocals or instrumental. Tap any point to read its time,
  frequency, note, wavelength and level
- **Energy by frequency band** and the **average spectrum** for vocals vs instrumental

### Settings
- Reference pitch A4 (default 440 Hz)
- Air temperature, which sets the speed of sound used for wavelengths (343.4 m/s at 20 °C)

## How the vocal separation works

Each short slice of the song is broken into frequencies (STFT), and each frequency is kept in
the vocal part when it is:
1. **centre-panned**: lead vocals are almost always mixed to the middle of a stereo
   image, so left and right agree in level and phase;
2. **pitched and sustained**: median-filter harmonic/percussive separation removes drum hits;
3. **in the voice range** (about 90 Hz – 11 kHz).

Whatever is not vocal becomes the instrumental part. This works well on most studio mixes and
runs in seconds on a phone. Centre-panned lead instruments (a solo sax, a lead synth) can leak
into the vocal part, and mono recordings separate less cleanly. Studio-grade stem separation
needs a neural network such as Demucs, which is far too heavy to run in a phone browser.

## Website

The same code is also a standalone website that works in any modern desktop or mobile browser.
On wide screens it switches to a two-column desktop layout, and you can drag and drop audio
files onto it.

Every push to the main branch (or `ccr-180482ca-j7jtdw`) runs the tests and then publishes
`www/` to **GitHub Pages** through `.github/workflows/pages.yml`, at
**https://medwak.github.io/Frequency_analyzer/**.

The first time, a repository admin may need to open **Settings → Pages** and set
**Source: GitHub Actions**, then re-run the "Deploy website" workflow.

## Running it

It's a Progressive Web App: plain HTML/CSS/JavaScript with no dependencies.

**Quickest way:** open `www/index.html` in Chrome, Edge or Firefox by double-clicking it.
Everything works from disk, including the microphone.

```bash
npm start          # or serve www/ at http://localhost:8080
npm test           # unit tests (Node 18+)
npm run build      # regenerate www/js/app.bundle.js after editing www/js/*.js
```

The source lives in the ES modules in `www/js/`. Browsers won't load ES modules from a
`file://` page, so `npm run build` bundles them, with the analysis worker inlined, into a
single plain script, `www/js/app.bundle.js`, which is what `index.html` loads. `npm test`
fails if the bundle is out of date.

To use it on a phone, open the website (or host the `www/` folder on any HTTPS host such as
Netlify or Cloudflare Pages) in Chrome (Android) or Safari (iOS) and choose
**Add to Home screen** / **Install app**. It then runs full-screen and works offline.
Browsers only allow microphone access over HTTPS (or on `localhost`).

### Building native Android / iOS apps (Capacitor)

`capacitor.config.json` is set up to wrap `www/` as a native app:

```bash
npm install @capacitor/core @capacitor/cli @capacitor/android @capacitor/ios
npx cap add android            # and/or: npx cap add ios
npx cap sync
npx cap open android           # build / run the APK in Android Studio
```

Then declare microphone access:
- **Android**: in `android/app/src/main/AndroidManifest.xml` add
  `<uses-permission android:name="android.permission.RECORD_AUDIO" />` and
  `<uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS" />`
- **iOS**: in `ios/App/App/Info.plist` add `NSMicrophoneUsageDescription`
  (for example "Used to measure the pitch and frequency of sounds").

## Project layout

```
www/
  index.html            app shell (Live and Music & files tabs, settings)
  css/app.css           mobile-first styles, light and dark themes
  js/dsp.js             FFT, YIN pitch, LPC formants, vowel, key, tempo, separation
  js/analysis.js        full-file analysis pipeline
  js/worker.js          runs the analysis off the UI thread
  js/live.js            live microphone analyser
  js/file.js            file decoding, results, stem playback and export
  js/charts.js          canvas charts (spectrum, spectrogram, contour, vowel chart)
  js/wav.js             WAV encoder
  js/app.bundle.js      generated single-file build of the above (npm run build)
  sw.js, manifest.webmanifest, icons/   installable / offline PWA
scripts/build.mjs       bundler for app.bundle.js (no dependencies)
test/                   unit tests and synthetic test signals
```
