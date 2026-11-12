/**
 * Beginner manual content. Section `id`s are the navigation anchors and must
 * match between languages (checked by tests). Figures live in `public/manual/`
 * and are produced by `tools/manual-media.mjs`.
 */
export interface ManualFigure {
  kind: 'img' | 'gif';
  src: string;
  alt: string;
}

export interface ManualBlock {
  kind: 'p' | 'tip' | 'warn';
  text: string;
}

export interface ManualSteps {
  kind: 'steps';
  items: string[];
}

export type ManualEntry = ManualBlock | ManualSteps | ManualFigure;

export interface ManualSection {
  id: string;
  title: string;
  entries: ManualEntry[];
}

export const manualEn: ManualSection[] = [
  {
    id: 'welcome',
    title: 'Welcome to Coso',
    entries: [
      { kind: 'p', text: 'Coso turns a lecture recording into readable notes on the very device you record with. Nothing is uploaded: the transcription engine (Whisper) runs inside the app itself, so your audio and your notes never leave this computer or phone.' },
      { kind: 'img', src: '/manual/img-start.png', alt: 'Coso start screen with the Start recording and Import audio buttons' },
      { kind: 'tip', text: 'You do not need an account. The only time Coso talks to the internet is to download the Whisper model once, or when you use Google Drive on purpose.' },
    ],
  },
  {
    id: 'first',
    title: 'Make your first transcript',
    entries: [
      { kind: 'p', text: 'You have two ways to get audio into Coso.' },
      {
        kind: 'steps',
        items: [
          'Record a lecture live: press the big orange “Start recording” button and let it run. You can pause and resume at any time.',
          'Import a file: press “Import audio” (or drag the file anywhere on the page) and choose a WAV, MP3, M4A, OGG, FLAC or WebM recording up to 4 hours long.',
        ],
      },
      { kind: 'gif', src: '/manual/gif-record.gif', alt: 'Recording starting, the live waveform moving, and Stop & transcribe leading to the progress screen' },
      { kind: 'p', text: 'The first time you transcribe, Coso downloads the Whisper model (about 80 MB). After that it works offline and starts instantly.' },
      { kind: 'tip', text: 'Record with the phone or recorder close to the speaker. Coso removes background noise, but a clear signal always gives better notes.' },
    ],
  },
  {
    id: 'progress',
    title: 'While it transcribes',
    entries: [
      { kind: 'img', src: '/manual/img-progress.png', alt: 'Progress card with the five stages: read audio, prepare models, write transcript, separate voices, save locally' },
      { kind: 'p', text: 'Long recordings are processed in 90-second chunks. After every chunk the progress is saved, so if the laptop closes or the tab crashes, Coso offers to resume exactly where it stopped — nothing is lost.' },
      { kind: 'p', text: 'When it finishes, the transcript opens automatically and is saved in the library on the left.' },
      { kind: 'warn', text: 'Keep the tab open while it works. Transcription uses your processor, and the browser pauses work in background tabs.' },
    ],
  },
  {
    id: 'reading',
    title: 'Read and search your notes',
    entries: [
      { kind: 'img', src: '/manual/img-transcript.png', alt: 'A finished transcript with speaker labels, timestamps and the search box' },
      { kind: 'p', text: 'Every passage shows who spoke and when. Press the small play icon next to a timestamp to hear that exact moment.' },
      {
        kind: 'steps',
        items: [
          'Search: press the search box (or Ctrl + F) to highlight words anywhere in the transcript.',
          'Filter: with more than one speaker, the chips at the top show one speaker at a time.',
          'Copy: the Copy button puts the visible passages on your clipboard.',
        ],
      },
      { kind: 'img', src: '/manual/img-sidebar.png', alt: 'Session library listing several transcripts grouped by day' },
    ],
  },
  {
    id: 'editing',
    title: 'Fix a word',
    entries: [
      { kind: 'p', text: 'Whisper is good, not perfect — names and technical words sometimes need a hand.' },
      { kind: 'gif', src: '/manual/gif-edit.gif', alt: 'Opening Edit, correcting a word in a passage, and saving with Enter' },
      {
        kind: 'steps',
        items: [
          'Press Edit at the top of the transcript.',
          'Click the passage you want to correct and type over it.',
          'Press Enter to save that passage, or Done to leave edit mode.',
        ],
      },
      { kind: 'tip', text: 'Your changes are saved automatically in this browser, together with the audio.' },
    ],
  },
  {
    id: 'player',
    title: 'Listen while you read',
    entries: [
      { kind: 'img', src: '/manual/img-player.png', alt: 'Player bar with rewind, play, forward, waveform and speed control' },
      { kind: 'p', text: 'The bar at the bottom plays the recording. The waveform shows how far you are; click anywhere on it to jump. The highlighted passage follows the audio as it plays.' },
      {
        kind: 'steps',
        items: [
          'Space plays or pauses, and the arrow keys skip 5 seconds.',
          'Press the 1× button to cycle speeds: 0.75×, 1×, 1.25×, 1.5× and 2×.',
          'The download icon saves the original audio file to your device.',
        ],
      },
    ],
  },
  {
    id: 'export',
    title: 'Export your notes',
    entries: [
      { kind: 'gif', src: '/manual/gif-export.gif', alt: 'Opening the Export menu and picking a format' },
      { kind: 'p', text: 'The Export button offers every format you might need:' },
      {
        kind: 'steps',
        items: [
          'Word document — formatted notes you can edit and print.',
          'PDF — ready to print or share.',
          'Plain text and Markdown — for pasting anywhere.',
          'Subtitles (SRT/VTT) — to caption a video of the lecture.',
          'Structured data (JSON) — with exact timestamps for other tools.',
          'Original audio — the recording itself, as a file.',
        ],
      },
    ],
  },
  {
    id: 'settings',
    title: 'Settings explained',
    entries: [
      { kind: 'p', text: 'Open Settings with the gear icon (or Ctrl + comma). Every option is saved automatically.' },
      { kind: 'img', src: '/manual/img-settings-model.png', alt: 'Settings, Speech model section with model, spoken language and offline download' },
      {
        kind: 'steps',
        items: [
          'Speech model — bigger models understand harder audio but download more and run slower. Whisper Base is a good default; Whisper Large v3 Turbo is the most accurate.',
          'Spoken language — pick the language of the lecture, or leave English and let Whisper detect it.',
          'Processing — “Separate speakers” labels each voice (Speaker 1, Speaker 2…). “Remove background noise” cleans room noise; Neural is the everyday choice.',
          'Reading — theme and text size for comfortable reading.',
          'App language — switch the whole interface between English and Spanish; the change is instant and saved.',
        ],
      },
      { kind: 'img', src: '/manual/img-settings-processing.png', alt: 'Settings, Processing section with speaker precision, speaker model and noise removal' },
      { kind: 'tip', text: 'Press “Download for offline use” once, before an exam week, and Coso will work on a plane or in a basement classroom.' },
      { kind: 'gif', src: '/manual/gif-language.gif', alt: 'Switching the app language from English to Español in Settings, with the interface flipping instantly' },
      { kind: 'img', src: '/manual/img-settings-reading.png', alt: 'Settings, Reading section with theme, transcript size and app language' },
    ],
  },
  {
    id: 'drive',
    title: 'Back up with Google Drive',
    entries: [
      { kind: 'img', src: '/manual/img-drive.png', alt: 'Google Drive dialog with the Continue with Google button' },
      { kind: 'p', text: 'Coso never uploads anything by itself. When you open the cloud icon, you can sign in with Google and choose to upload the open recording, or import audio that is already in your Drive.' },
      {
        kind: 'steps',
        items: [
          'Press Continue with Google and sign in on Google’s own page — Coso never sees your password.',
          'Upload sends the open recording to the “Coso Audio” folder in your Drive.',
          'Import lists the audio files in your Drive so you can transcribe them on this device.',
        ],
      },
      { kind: 'warn', text: 'Only recordings you choose to upload leave this device. Everything else stays local.' },
    ],
  },
  {
    id: 'offline',
    title: 'Install and use offline',
    entries: [
      { kind: 'p', text: 'Coso is a web app that can live on your computer like a normal program.' },
      {
        kind: 'steps',
        items: [
          'In Chrome or Edge, open the Coso address and look for the install icon in the address bar (or menu → “Install app”).',
          'On a phone, open the browser menu and choose “Add to Home screen”.',
          'After installing, Coso opens in its own window, works offline, and keeps your library.',
        ],
      },
      { kind: 'tip', text: 'Download the speech model first (Settings → “Download for offline use”); after that no internet is needed at all.' },
    ],
  },
  {
    id: 'phone',
    title: 'Using Coso on a phone',
    entries: [
      { kind: 'img', src: '/manual/img-phone.png', alt: 'Coso on a phone, with the record button and the library drawer' },
      { kind: 'p', text: 'On a small screen the library becomes a drawer: the menu button at the top opens it, and you close it by swiping it away or tapping the page.' },
      { kind: 'img', src: '/manual/img-phone-drawer.png', alt: 'The phone library drawer open, listing recent sessions over a dimmed page' },
      {
        kind: 'steps',
        items: [
          'Record a lecture with the orange button — the phone asks for microphone permission the first time.',
          'The big buttons are sized for thumbs, and the player sits at the bottom.',
          'Everything you record is saved on the phone; export it or back it up to Drive from there.',
        ],
      },
      { kind: 'warn', text: 'Transcribing a whole lecture on a phone is slower than on a computer. For long recordings, prefer the computer and keep the phone for quick notes.' },
    ],
  },
  {
    id: 'help',
    title: 'If something goes wrong',
    entries: [
      {
        kind: 'steps',
        items: [
          '“That did not finish” — press Try again. Coso resumes from the last saved chunk, so little time is lost.',
          'Out of memory or very slow — choose a smaller model (Whisper Tiny or Base) in Settings, or turn off Thorough speaker separation.',
          'No microphone — check that the browser has permission (padlock icon in the address bar) and that no other app is holding the mic.',
          'Wrong language in the transcript — set “Spoken language” in Settings instead of automatic detection.',
          'A passage is wrong — fix it with Edit; corrections stay saved.',
        ],
      },
      { kind: 'tip', text: 'Everything is stored in this browser. Deleting browser data deletes your library — export anything you want to keep first.' },
    ],
  },
];
