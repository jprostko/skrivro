// ================= Localization =================
//
// Minimal pragmatic translation system: English and Swedish only,
// no i18n framework, no JSON loader, no runtime language switching.
// Language is resolved once by the inline <script> at end of body
// (which reads the Rust-side config override or falls back to
// navigator.language auto-detect), landing on window.__SKRIVRO_LANG__.
//
// NOT translated (stays English everywhere):
// - Ex commands (:w, :open, :syncpreview, etc.), input syntax (real
//   Vim doesn't localize command names either)
// - Keyboard shortcut names (Ctrl+S, ⌃⌘T on Mac, etc.), physical key
//   identifiers, not translatable text
// - Filename strings like untitled.adoc, since filenames don't
//   localize
// - App name "Skrivro", coined from Swedish, nothing to translate
//
// To extend to a new language later: add a STRINGS_<LANG> map, update
// the resolution logic in the inline <script>, extend the Rust-side
// config parser to accept the new language code, done. If the map
// grows past ~100-200 entries or multiple languages accumulate, this
// should graduate to a proper i18n setup. For now it's tractable.
export const lang = window.__SKRIVRO_LANG__ || "en";

// Relabels for @codemirror/search's find/replace panel, applied via
// EditorState.phrases. English just renames "by word" to "whole word"
// and "regexp" to "regex". Swedish localizes the whole panel. Keys are
// CM's own phrase strings, so anything not listed falls back to CM's
// default.
export const searchPhrases: Record<string, string> =
  lang === "sv"
    ? {
        Find: "Sök",
        Replace: "Ersätt",
        next: "nästa",
        previous: "föregående",
        all: "alla",
        "match case": "skiftläge",
        regexp: "regex",
        "by word": "helord",
        replace: "ersätt",
        "replace all": "ersätt alla",
        close: "stäng",
      }
    : { "by word": "whole word", regexp: "regex" };

// Mac detection for keyboard conventions. On Mac, the app's shortcut
// modifier is Cmd (metaKey), not Ctrl, matching every native Mac app.
// Ctrl on Mac is deliberately left alone so Vim can keep its own
// Ctrl-based bindings (Ctrl+V for V-BLOCK, Ctrl+W for window commands,
// Ctrl+R for redo, Ctrl+D/U/F/B for scrolling, etc.). Linux and Windows
// stay strict on Ctrl, and metaKey on those platforms is the Super/Win
// key, which is WM-reserved and almost never reaches a userland app
// anyway.
//
// navigator.userAgent match is good enough: this is a broad platform
// gate, not a fingerprint. No @tauri-apps/plugin-os dependency needed.
export const isMac = /Mac/i.test(navigator.userAgent);

// Record<string, string> annotation lets tr() and translateStaticText
// index this table with dynamic keys at runtime. Without the
// annotation TS infers the narrow literal shape of the object and
// rejects string-indexed lookups under strict mode.
export const STRINGS_SV: Record<string, string> = {
  // Status bar: mode pill labels. NORMAL and V-BLOCK stay unchanged
  // (NORMAL is the same word in Swedish, and BLOCK is the same in
  // Swedish as well, since the abbreviated "V-" prefix is
  // language-neutral).
  INSERT: "INFOGA",
  REPLACE: "ERSÄTT",
  COMMAND: "KOMMANDO",
  VISUAL: "VISUELL",
  "V-LINE": "V-RAD",

  // Status bar: cursor position prefixes and content-count labels
  Ln: "Rad",
  Col: "Kol",
  word: "ord",
  words: "ord",
  line: "rad",
  lines: "rader",
  char: "tecken",
  chars: "tecken", // neuter noun, same plural form as singular

  // Status bar: spellcheck-off indicator (on in config, toggled off at
  // runtime). Parens added at the call site.
  "spellcheck off": "stavningskontroll av",

  // Status bar: user-supplied-dictionary states. Swedish (and any non
  // en-US English) is loaded from <config>/dictionaries/, and these show
  // when a requested Swedish dictionary file is absent. Parens added at
  // the call site.
  "Swedish dictionary not found": "svensk ordlista saknas",
  "Swedish dictionary not found, English only": "svensk ordlista saknas, endast engelska",
  "Swedish dictionary not found, using English": "svensk ordlista saknas, använder engelska",

  // Vim-panel / Ex-command channel: error messages and readbacks. By
  // design these stay English (the Vim way): E-code prefixes
  // (E37:/E212:/E474:), command-argument tokens
  // (on/off/narrow/medium/wide/full), config keys (spellcheck-language),
  // and the ! modifier. %s placeholders fill positionally from tr() args.
  // "Format: %s" has no entry, since Format is identical in Swedish.
  "E212: Can't open file for writing: %s (%s)": "E212: Kan inte öppna filen för skrivning: %s (%s)",
  "E212: Can't open file for writing (%s)": "E212: Kan inte öppna filen för skrivning (%s)",
  "E484: Can't open file %s (%s)": "E484: Kan inte öppna filen %s (%s)",
  "E484: Can't open file (%s)": "E484: Kan inte öppna filen (%s)",
  "E37: No write since last change (add ! to override)":
    "E37: Ingen skrivning sedan senaste ändring (lägg till ! för att tvinga)",
  'E474: Invalid format "%s" (expected asciidoc, markdown, or text)':
    'E474: Ogiltigt format "%s" (förväntade asciidoc, markdown eller text)',
  'E474: Invalid argument "%s" (expected on or off)':
    'E474: Ogiltigt argument "%s" (förväntade on eller off)',
  'E474: Invalid argument "%s" (expected narrow, medium, wide, or full)':
    'E474: Ogiltigt argument "%s" (förväntade narrow, medium, wide eller full)',
  "Syntax highlighting: %s": "Syntaxmarkering: %s",
  "Spellcheck: %s": "Stavningskontroll: %s",
  "Spellcheck: off (disabled in config)": "Stavningskontroll: off (inaktiverad i konfigurationen)",
  "Width mode: %s": "Breddläge: %s",
  "Table of contents: %s": "Innehållsförteckning: %s",
  "All local settings have been reset to defaults. Restart the application to apply them.":
    "Alla lokala inställningar har återställts till standard. Starta om programmet för att ändringarna ska gälla.",
  "All local settings and data have been reset to first-launch defaults. Restart the application to apply them.":
    "Alla lokala inställningar och all data har återställts till fabriksinställningar. Starta om programmet för att ändringarna ska gälla.",
  "Factory reset incomplete: %s": "Fabriksåterställning ofullständig: %s",
  "Spellcheck is disabled in config (spellcheck-language = off)":
    "Stavningskontroll är inaktiverad i konfigurationen (spellcheck-language = off)",
  "Spellcheck is off in the editor (turn it on to add or remove words)":
    "Stavningskontroll är av i editorn (slå på den för att lägga till eller ta bort ord)",
  "No word under the cursor": "Inget ord under markören",
  'Added "%s" to custom words': 'La till "%s" i egna ord',
  '"%s" is already a custom word': '"%s" är redan ett eget ord',
  'Removed "%s" from custom words': 'Tog bort "%s" från egna ord',
  '"%s" is not a custom word': '"%s" är inte ett eget ord',
  "%s is too large to open (%s, limit %s)": "%s är för stor för att öppna (%s, gräns %s)",

  // Confirm dialog: message and button labels
  "You have unsaved changes. Discard them?": "Du har osparade ändringar. Kasta dem?",
  Discard: "Kasta",
  Cancel: "Avbryt",

  // Help dialog: top-level h2 headings (textContent-matched)
  "Keyboard shortcuts": "Kortkommandon",
  "Vim Ex commands (Vim mode only)":
    'Vim Ex-kommandon <span class="help-note">(endast i Vim-läge)</span>',
  "Vim normal mode (Vim mode only)":
    'Vim normalläge <span class="help-note">(endast i Vim-läge)</span>',

  // Help dialog: h3 section headings. "File" repeats under both
  // Keyboard shortcuts and Vim Ex commands, and the DOM sweep
  // translates both occurrences since it matches by textContent.
  File: "Fil",
  Display: "Visning",
  Navigation: "Navigering",
  Quit: "Avsluta",
  Preview: "Förhandsvisning",
  Modes: "Lägen",
  Commands: "Kommandon",
  Width: "Bredd",
  "Table of contents": "Innehållsförteckning",
  Reset: "Återställning",
  Spelling: "Stavning",
  Find: "Sök",
  Editing: "Redigering",

  // Help dialog: keyboard shortcut descriptions
  Save: "Spara",
  "Save as": "Spara som",
  Open: "Öppna",
  "Open (Vim users use :open)": "Öppna (Vim-användare använder :open)",
  New: "Ny",
  "Undo the last edit": "Ångra senaste ändringen",
  "Redo the last undone edit (Vim users use Ctrl+R)":
    "Gör om senaste ångrade ändringen (Vim-användare använder Ctrl+R)",
  "Move the status bar to the top or bottom": "Flytta statusfältet längst upp eller längst ned",
  "Toggle gutter": "Växla radnummermarginal",
  "Toggle Vim mode": "Växla Vim-läge",
  "Split mode (editor + preview)": "Delat läge (redigerare + förhandsvisning)",
  "Editor only": "Endast redigerare",
  "Preview only": "Endast förhandsvisning",
  "Toggle this help": "Växla denna hjälp",
  "Show or hide the status bar": "Visa eller dölj statusfältet",
  "Show or hide the help button": "Visa eller dölj hjälpknappen",
  "Cycle format (AsciiDoc / Markdown / Text)": "Växla format (AsciiDoc / Markdown / Text)",
  "Toggle syntax highlighting": "Växla syntaxmarkering",
  "Toggle spellcheck": "Växla stavningskontroll",
  "Cycle single-pane width (narrow / medium / wide / full)":
    "Växla bredd för enskild panel (smal / medium / bred / full)",
  "Toggle table of contents visibility (resets on launch)":
    "Växla synlighet för innehållsförteckning (återställs vid start)",
  "Sync preview to cursor": "Synka förhandsvisning till markör",
  "Toggle focus between editor and preview": "Växla fokus mellan redigerare och förhandsvisning",
  // Help dialog: find/replace (Ctrl+F / ⌘F keybind + :find Ex command)
  "Find and replace (Vim users use :find)": "Sök och ersätt (Vim-användare använder :find)",
  "Open find and replace": "Öppna sök och ersätt",
  // Ex command descriptions for :format. The format names (asciidoc /
  // markdown / text) stay English, since they are the literal command
  // arguments the user types.
  "Show the current format": "Visa aktuellt format",
  "Set format: asciidoc / markdown / text": "Ställ in format: asciidoc / markdown / text",
  "Direct shortcuts for each format": "Direkta genvägar för varje format",
  // Ex command description for :syntax. The surrounding
  // <kbd>Ctrl+Alt+Y</kbd> is literal and untranslated.
  "Show whether editor syntax highlighting is on or off":
    "Visa om syntaxmarkering i redigeraren är på eller av",
  "Turn editor syntax highlighting on or off (mirrors Ctrl+Alt+Y)":
    "Slå på eller av syntaxmarkering i redigeraren (motsvarar <kbd>Ctrl+Alt+Y</kbd>)",

  // Ex command descriptions for :spell. The literal config-key name
  // (spellcheck-language) and the filename (skrivro.conf) stay English
  // (same convention as the allow-external-images entry below).
  "Show whether spellcheck is on or off (offline, set the language with spellcheck-language in skrivro.conf)":
    "Visa om stavningskontroll är på eller av (offline, ställ in språket med spellcheck-language i skrivro.conf)",
  "Turn spellcheck on or off (mirrors Ctrl+Alt+K)":
    "Slå på eller av stavningskontroll (motsvarar <kbd>Ctrl+Alt+K</kbd>)",
  "Add the word under the cursor to your custom dictionary (Vim zg)":
    "Lägg till ordet under markören i din egen ordlista (Vim <kbd>zg</kbd>)",
  "Remove the word under the cursor from your custom dictionary (Vim zug)":
    "Ta bort ordet under markören från din egen ordlista (Vim <kbd>zug</kbd>)",
  // Right-click menu items (translated at runtime via tr(), not the DOM sweep).
  "Add to dictionary": "Lägg till i ordlistan",
  "Remove from dictionary": "Ta bort från ordlistan",

  // Ex command descriptions for :width.
  "Show the current single-pane width mode": "Visa aktuellt breddläge för enskild panel",
  "Set the width mode explicitly (mirrors Ctrl+Alt+C's cycle)":
    "Ställ in breddläget uttryckligen (motsvarar <kbd>Ctrl+Alt+C</kbd>:s växling)",

  // Ex command descriptions for :toc.
  "Show whether the table of contents visibility override is on or off":
    "Visa om åsidosättning av innehållsförteckningens synlighet är på eller av",
  "Show or hide the table of contents (mirrors Ctrl+Alt+I, resets on launch)":
    "Visa eller dölj innehållsförteckningen (motsvarar <kbd>Ctrl+Alt+I</kbd>, återställs vid start)",

  // Ex command descriptions for :RESETSETTINGS and :FACTORYRESET.
  "Reset all local settings to defaults (typed exactly as shown, restart required)":
    "Återställ alla lokala inställningar till standard (skrivs exakt som visat, omstart krävs)",
  "Reset settings, autosave draft, personal dictionary, and window state to first-launch defaults (typed exactly as shown, restart required, config and theme files stay)":
    "Återställ inställningar, autosparat utkast, personlig ordlista och fönsterläge till fabriksinställningar (skrivs exakt som visat, omstart krävs, konfigurations- och temafiler behålls)",

  // Help dialog: placeholder labels inside <kbd><var>...</var></kbd>
  // syntax examples (e.g. ":w <var>filename</var>"). Translated even
  // though the surrounding Ex command stays English, because the
  // placeholder names a user-supplied value rather than being part
  // of the command syntax. Distinct from actual filename strings
  // (e.g. untitled.adoc), which don't localize per the rules above.
  filename: "filnamn",
  name: "namn",

  // Help dialog: Vim Ex command descriptions
  "Save current file": "Spara aktuell fil",
  "Write buffer contents to a path (current buffer association unchanged)":
    "Skriv buffertinnehåll till en sökväg (aktuell buffertassociation oförändrad)",
  "Save as + rename the buffer": "Spara som + byt namn på bufferten",
  "Reload current file from disk": "Ladda om aktuell fil från disken",
  "Open a different file (refuses if dirty)": "Öppna en annan fil (vägrar om osparad)",
  "Force reload or open, discarding dirty buffer":
    "Tvinga omladdning eller öppning, kasta osparad buffert",
  "New empty buffer": "Ny tom buffert",
  "Show the file picker dialog": "Visa fildialogen",

  // Help dialog: Vim Quit command descriptions
  "Quit (confirm if dirty)": "Avsluta (bekräfta om osparad)",
  "Force quit, discard changes without prompting": "Tvinga avsluta, kasta ändringar utan att fråga",
  "Save and quit (always writes, updates mtime)":
    "Spara och avsluta (skriver alltid, uppdaterar mtime)",
  "Save only if dirty, then quit (mtime untouched on clean buffer)":
    "Spara endast om osparad, sedan avsluta (mtime orörd för ren buffert)",
  "Force save even if clean, then quit": "Tvinga spara även om ren, sedan avsluta",
  "Quit all (single-window alias for :q)": "Avsluta alla (alias för :q för enstaka fönster)",
  "Force quit all": "Tvinga avsluta alla",
  "Save all, quit all": "Spara alla, avsluta alla",
  "Save if dirty (all), quit all": "Spara om osparad (alla), avsluta alla",

  // Help dialog: Vim Preview command descriptions
  "Snap preview to the block containing the caret line":
    "Snäpp förhandsvisning till blocket som innehåller markörraden",

  // Help dialog: Vim normal mode / Modes
  "Insert mode (before / after cursor)": "Infogningsläge (före / efter markör)",
  "Visual mode (character-wise)": "Visuellt läge (teckenvis)",
  "Visual line mode": "Visuellt radläge",
  "Visual block mode": "Visuellt blockläge",
  "Replace mode": "Ersättningsläge",
  "Ex command line": "Ex-kommandorad",
  "Return to normal mode": "Återgå till normalläge",

  // Help dialog: Vim normal mode Commands
  "Snap preview to cursor (same as :syncpreview)":
    "Snäpp förhandsvisning till markör (samma som :syncpreview)",
  "Save if dirty, quit (same as :x)": "Spara om osparad, avsluta (samma som :x)",
  "Force quit, discard changes (same as :q!)": "Tvinga avsluta, kasta ändringar (samma som :q!)",
  "Add the word under the cursor to your custom dictionary (same as :spellgood)":
    "Lägg till ordet under markören i din egen ordlista (samma som :spellgood)",
  "Remove the word under the cursor from your custom dictionary (same as :spellundo)":
    "Ta bort ordet under markören från din egen ordlista (samma som :spellundo)",

  // Preview link handling: the peek banner label (runtime tr), the
  // banner's return button (static HTML, swept by translateStaticText),
  // and the pane-local toast messages for swallowed link clicks.
  "Viewing %s": "Visar %s",
  Return: "Tillbaka",
  "Unable to follow this link": "Det går inte att följa den här länken",
  "Link target not found: %s": "Länkmålet hittades inte: %s",

  // Help dialog: preview links section. The .help-plain spans in the
  // key column are swept alongside the descriptions.
  "Preview links": "Länkar i förhandsvisningen",
  "Web link": "Webblänk",
  "File link": "Fillänk",
  "Opens in your system browser": "Öppnas i systemets webbläsare",
  "Shows the linked document in the preview without leaving your file. Return with the bar at the top of the preview, by editing, or with sync to cursor.":
    "Visar det länkade dokumentet i förhandsvisningen utan att lämna din fil. Gå tillbaka med fältet överst i förhandsvisningen, genom att redigera eller med synka till markör.",
  "Return to your document (from the editor with Vim on, NORMAL mode only)":
    "Gå tillbaka till ditt dokument (från redigeraren med Vim på, endast i NORMAL-läge)",

  // Preview pane: external-image gate placeholder. The literal
  // `allow-external-images` config-key name stays English in both
  // languages (input syntax).
  "image blocked": "bild blockerad",
  see: "se",
  "External image blocked": "Extern bild blockerad",
  "To render, set allow-external-images = true in skrivro.conf and restart.":
    "För att visa, ställ in allow-external-images = true i skrivro.conf och starta om.",
};

// Translation helper. Returns the Swedish string if current language
// is 'sv' and the map contains an entry, and otherwise returns the
// input unchanged. Missing entries are silently un-translated,
// acceptable for partial coverage.
//
// Named `tr` rather than the conventional `t` because `t` is already
// taken as module-level import alias for @lezer/highlight's `tags`
// (`import { tags as t }`). Renaming our helper to `tr` is simpler
// than renaming the deeply-used Lezer import.
// Optional %s placeholders are filled positionally from args, so a
// message with interpolated values stays one translatable key (the
// Vim-panel error/readback channel needs this, while static UI uses
// tr(en)).
export const tr = (en: string, ...args: unknown[]): string => {
  const s = lang === "sv" ? (STRINGS_SV[en] ?? en) : en;
  if (args.length === 0) return s;
  let i = 0;
  return s.replace(/%s/g, () => String(args[i++]));
};

// Translate the help dialog's static content in-place. Runs once at
// init since the dialog DOM doesn't change at runtime. Also handles
// the confirm dialog's buttons (Cancel / Discard) which are static
// in HTML too but only visible when the dialog is opened: no FOUC
// concern, just needs to be done before the first confirm shows up.
//
// Uses innerHTML (not textContent) so future translation entries can
// embed <kbd> elements or other inline markup without requiring a code
// change. No current entry uses this, but the door's open. All
// translation values are author-controlled so there's no XSS concern
// from the innerHTML write.
export const translateStaticText = () => {
  if (lang !== "sv") return;
  const selectors = [
    ".help-dialog h2",
    ".help-dialog h3",
    ".help-dialog .help-desc",
    // <var> placeholders inside .help-key kbd examples (e.g. the
    // "filename" in ":w <var>filename</var>"). Surrounding kbd
    // contents stay English (Ex commands and key names don't
    // translate) but the placeholder label is a user-facing word.
    ".help-dialog .help-key var",
    // Plain-prose key-column labels (the Preview links section uses
    // the key column for click classes rather than keystrokes).
    ".help-dialog .help-plain",
    "#confirmCancelBtn",
    "#confirmOkBtn",
    "#peekReturnBtn",
  ];
  selectors.forEach((sel) => {
    document.querySelectorAll(sel).forEach((el) => {
      // Collapse interior whitespace so descriptions the formatter has
      // wrapped across HTML lines still match their single-line keys.
      const key = el.textContent.trim().replace(/\s+/g, " ");
      const value = STRINGS_SV[key];
      if (value !== undefined) {
        el.innerHTML = value;
      }
    });
  });
};
