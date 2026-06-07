// ================= Localization =================
//
// Minimal pragmatic translation system — English and Swedish only,
// no i18n framework, no JSON loader, no runtime language switching.
// Language is resolved once by the inline <script> at end of body
// (which reads the Rust-side config override or falls back to
// navigator.language auto-detect), landing on window.__SKRIVRO_LANG__.
//
// NOT translated (stays English everywhere):
// - Ex commands (:w, :open, :syncpreview, etc.) — input syntax, same
//   rule real Vim follows (Swedish vim users still type :w, not :skriv)
// - Keyboard shortcut names (Ctrl+S, ⌃⌘T on Mac, etc.) — physical key
//   identifiers, not translatable text
// - Filename strings like untitled.adoc — filenames don't localize
// - App name "Skrivro" — already a Swedish word
//
// To extend to a new language later: add a STRINGS_<LANG> map, update
// the resolution logic in the inline <script>, extend the Rust-side
// config parser to accept the new language code, done. If the map
// grows past ~100-200 entries or multiple languages accumulate, this
// should graduate to a proper i18n setup. For now it's tractable.
export const lang = window.__SKRIVRO_LANG__ || 'en';

// Mac detection for keyboard conventions. On Mac, the app's shortcut
// modifier is Cmd (metaKey), not Ctrl — matching every native Mac app.
// Ctrl on Mac is deliberately left alone so Vim can keep its own
// Ctrl-based bindings (Ctrl+V for V-BLOCK, Ctrl+W for window commands,
// Ctrl+R for redo, Ctrl+D/U/F/B for scrolling, etc.). Linux and Windows
// stay strict on Ctrl; metaKey on those platforms is the Super/Win key,
// which is WM-reserved and almost never reaches a userland app anyway.
//
// navigator.userAgent match is good enough — this is a broad platform
// gate, not a fingerprint. No @tauri-apps/plugin-os dependency needed.
export const isMac = /Mac/i.test(navigator.userAgent);

// Record<string, string> annotation lets tr() and translateStaticText
// index this table with dynamic keys at runtime. Without the
// annotation TS infers the narrow literal shape of the object and
// rejects string-indexed lookups under strict mode.
export const STRINGS_SV: Record<string, string> = {
  // Status bar — mode pill labels. NORMAL and V-BLOCK stay unchanged
  // (NORMAL is the same word in Swedish; BLOCK is the same in Swedish
  // as well — the abbreviated "V-" prefix is language-neutral).
  'INSERT': 'INFOGA',
  'REPLACE': 'ERSÄTT',
  'COMMAND': 'KOMMANDO',
  'VISUAL': 'VISUELL',
  'V-LINE': 'V-RAD',

  // Status bar — cursor position prefixes and content-count labels
  'Ln': 'Rad',
  'Col': 'Kol',
  'word': 'ord',
  'words': 'ord',
  'line': 'rad',
  'lines': 'rader',
  'char': 'tecken',
  'chars': 'tecken',  // neuter noun — same plural form as singular

  // Confirm dialog — message and button labels
  'You have unsaved changes. Discard them?': 'Du har osparade ändringar. Kasta dem?',
  'Discard': 'Kasta',
  'Cancel': 'Avbryt',

  // Help dialog — top-level h2 headings (textContent-matched)
  'Keyboard shortcuts': 'Kortkommandon',
  'Vim Ex commands (vim mode only)': 'Vim Ex-kommandon <span class="help-note">(endast i vim-läge)</span>',
  'Vim normal mode (vim mode only)': 'Vim normalläge <span class="help-note">(endast i vim-läge)</span>',

  // Help dialog — h3 section headings. "File" repeats under both
  // Keyboard shortcuts and Vim Ex commands; DOM sweep translates both
  // occurrences since it matches by textContent.
  'File': 'Fil',
  'Display': 'Visning',
  'Navigation': 'Navigering',
  'Quit': 'Avsluta',
  'Preview': 'Förhandsvisning',
  'Modes': 'Lägen',
  'Commands': 'Kommandon',
  'Width': 'Bredd',
  'Table of contents': 'Innehållsförteckning',
  'Spelling': 'Stavning',
  'Find': 'Sök',

  // Help dialog — keyboard shortcut descriptions
  'Save': 'Spara',
  'Save as': 'Spara som',
  'Open': 'Öppna',
  'New': 'Ny',
  'Toggle titlebar': 'Växla titelrad',
  'Toggle gutter': 'Växla radnummermarginal',
  'Toggle vim mode': 'Växla vim-läge',
  'Split mode (editor + preview)': 'Delat läge (redigerare + förhandsvisning)',
  'Editor only': 'Endast redigerare',
  'Preview only': 'Endast förhandsvisning',
  'Toggle this help': 'Växla denna hjälp',
  'Toggle status bar': 'Växla statusfält',
  'Cycle format (AsciiDoc / Markdown / Text)': 'Växla format (AsciiDoc / Markdown / Text)',
  'Toggle syntax highlighting': 'Växla syntaxmarkering',
  'Toggle spellcheck': 'Växla stavningskontroll',
  'Cycle single-pane width (narrow / medium / wide / full)': 'Växla bredd för enskild panel (smal / medium / bred / full)',
  'Toggle table of contents visibility (resets on launch)': 'Växla synlighet för innehållsförteckning (återställs vid start)',
  'Sync preview to cursor': 'Synka förhandsvisning till markör',
  'Toggle focus between editor and preview': 'Växla fokus mellan redigerare och förhandsvisning',
  // Help dialog — find/replace (Ctrl+F keybind + :find Ex command)
  'Find and replace (vim users use :find)': 'Sök och ersätt (vim-användare använder :find)',
  'Open find and replace': 'Öppna sök och ersätt',
  // Ex command description for :syntax. The surrounding
  // <kbd>Ctrl+Alt+Y</kbd> is literal and untranslated.
  'Show whether editor syntax highlighting is on or off': 'Visa om syntaxmarkering i redigeraren är på eller av',
  'Turn editor syntax highlighting on or off (mirrors Ctrl+Alt+Y)': 'Slå på eller av syntaxmarkering i redigeraren (motsvarar <kbd>Ctrl+Alt+Y</kbd>)',

  // Ex command descriptions for :spell. The literal config-key name
  // (spellcheck-language) and the filename (skrivro.conf) stay English
  // — same convention as the allow-external-images entry below.
  'Show whether spellcheck is on or off (offline, set the language with spellcheck-language in skrivro.conf)':
    'Visa om stavningskontroll är på eller av (offline, ställ in språket med spellcheck-language i skrivro.conf)',
  'Turn spellcheck on or off (mirrors Ctrl+Alt+K)': 'Slå på eller av stavningskontroll (motsvarar <kbd>Ctrl+Alt+K</kbd>)',
  'Add the word under the cursor to your custom dictionary (vim zg)':
    'Lägg till ordet under markören i din egen ordlista (vim <kbd>zg</kbd>)',
  'Remove the word under the cursor from your custom dictionary (vim zug)':
    'Ta bort ordet under markören från din egen ordlista (vim <kbd>zug</kbd>)',
  // Right-click menu items (translated at runtime via tr(), not the DOM sweep).
  'Add to dictionary': 'Lägg till i ordlistan',
  'Remove from dictionary': 'Ta bort från ordlistan',

  // Ex command descriptions for :width.
  'Show the current single-pane width mode': 'Visa aktuellt breddläge för enskild panel',
  "Set the width mode explicitly (mirrors Ctrl+Alt+C's cycle)": "Ställ in breddläget uttryckligen (motsvarar <kbd>Ctrl+Alt+C</kbd>:s växling)",

  // Ex command descriptions for :toc.
  'Show whether the TOC visibility override is on or off': 'Visa om åsidosättning av innehållsförteckningens synlighet är på eller av',
  'Show or hide the TOC (mirrors Ctrl+Alt+I, resets on launch)': 'Visa eller dölj innehållsförteckningen (motsvarar <kbd>Ctrl+Alt+I</kbd>, återställs vid start)',

  // Help dialog — placeholder labels inside <kbd><var>...</var></kbd>
  // syntax examples (e.g. ":w <var>filename</var>"). Translated even
  // though the surrounding Ex command stays English, because the
  // placeholder names a user-supplied value rather than being part
  // of the command syntax. Distinct from actual filename strings
  // (e.g. untitled.adoc), which don't localize per the rules above.
  'filename': 'filnamn',

  // Help dialog — Vim Ex command descriptions
  'Save current file': 'Spara aktuell fil',
  'Write buffer contents to a path (current buffer association unchanged)': 'Skriv buffertinnehåll till en sökväg (aktuell buffertassociation oförändrad)',
  'Save as + rename the buffer': 'Spara som + byt namn på bufferten',
  'Reload current file from disk': 'Ladda om aktuell fil från disken',
  'Open a different file (refuses if dirty)': 'Öppna en annan fil (vägrar om osparad)',
  'Force reload or open, discarding dirty buffer': 'Tvinga omladdning eller öppning, kasta osparad buffert',
  'New empty buffer': 'Ny tom buffert',
  'Show the file picker dialog': 'Visa fildialogen',

  // Help dialog — Vim Quit command descriptions
  'Quit (confirm if dirty)': 'Avsluta (bekräfta om osparad)',
  'Force quit, discard changes without prompting': 'Tvinga avsluta, kasta ändringar utan att fråga',
  'Save and quit (always writes, updates mtime)': 'Spara och avsluta (skriver alltid, uppdaterar mtime)',
  'Save only if dirty, then quit (mtime untouched on clean buffer)': 'Spara endast om osparad, sedan avsluta (mtime orörd för ren buffert)',
  'Force save even if clean, then quit': 'Tvinga spara även om ren, sedan avsluta',
  'Quit all (single-window alias for :q)': 'Avsluta alla (alias för :q för enstaka fönster)',
  'Force quit all': 'Tvinga avsluta alla',
  'Save all, quit all': 'Spara alla, avsluta alla',
  'Save if dirty (all), quit all': 'Spara om osparad (alla), avsluta alla',

  // Help dialog — Vim Preview command descriptions
  'Snap preview to the block containing the caret line': 'Snäpp förhandsvisning till blocket som innehåller markörraden',

  // Help dialog — Vim normal mode / Modes
  'Insert mode (before / after cursor)': 'Infogningsläge (före / efter markör)',
  'Visual mode (character-wise)': 'Visuellt läge (teckenvis)',
  'Visual line mode': 'Visuellt radläge',
  'Visual block mode': 'Visuellt blockläge',
  'Replace mode': 'Ersättningsläge',
  'Ex command line': 'Ex-kommandorad',
  'Return to normal mode': 'Återgå till normalläge',

  // Help dialog — Vim normal mode Commands
  'Snap preview to cursor (same as :syncpreview)': 'Snäpp förhandsvisning till markör (samma som :syncpreview)',
  'Save if dirty, quit (same as :x)': 'Spara om osparad, avsluta (samma som :x)',
  'Force quit, discard changes (same as :q!)': 'Tvinga avsluta, kasta ändringar (samma som :q!)',
  'Add the word under the cursor to your custom dictionary (same as :spellgood)':
    'Lägg till ordet under markören i din egen ordlista (samma som :spellgood)',
  'Remove the word under the cursor from your custom dictionary (same as :spellundo)':
    'Ta bort ordet under markören från din egen ordlista (samma som :spellundo)',

  // Preview pane — external-image gate placeholder. The literal
  // `allow-external-images` config-key name stays English in both
  // languages (input syntax).
  'image blocked': 'bild blockerad',
  'see': 'se',
  'External image blocked': 'Extern bild blockerad',
  'To render, set allow-external-images = true in skrivro.conf and restart.':
    'För att visa, ställ in allow-external-images = true i skrivro.conf och starta om.',
};

// Translation helper. Returns the Swedish string if current language
// is 'sv' and the map contains an entry; otherwise returns the input
// unchanged. Missing entries are silently un-translated — acceptable
// for partial coverage.
//
// Named `tr` rather than the conventional `t` because `t` is already
// taken as module-level import alias for @lezer/highlight's `tags`
// (`import { tags as t }`). Renaming our helper to `tr` is simpler
// than renaming the deeply-used Lezer import.
export const tr = (en: string): string => {
  if (lang !== 'sv') return en;
  return STRINGS_SV[en] ?? en;
};

// Translate the help dialog's static content in-place. Runs once at
// init since the dialog DOM doesn't change at runtime. Also handles
// the confirm dialog's buttons (Cancel / Discard) which are static
// in HTML too but only visible when the dialog is opened — no FOUC
// concern, just needs to be done before the first confirm shows up.
//
// Uses innerHTML (not textContent) so future translation entries can
// embed <kbd> elements or other inline markup without requiring a code
// change. No current entry uses this, but the door's open. All
// translation values are author-controlled so there's no XSS concern
// from the innerHTML write.
export const translateStaticText = () => {
  if (lang !== 'sv') return;
  const selectors = [
    '.help-dialog h2',
    '.help-dialog h3',
    '.help-dialog .help-desc',
    // <var> placeholders inside .help-key kbd examples (e.g. the
    // "filename" in ":w <var>filename</var>"). Surrounding kbd
    // contents stay English (Ex commands and key names don't
    // translate) but the placeholder label is a user-facing word.
    '.help-dialog .help-key var',
    '#confirmCancelBtn',
    '#confirmOkBtn',
  ];
  selectors.forEach((sel) => {
    document.querySelectorAll(sel).forEach((el) => {
      const key = el.textContent.trim();
      const value = STRINGS_SV[key];
      if (value !== undefined) {
        el.innerHTML = value;
      }
    });
  });
};
