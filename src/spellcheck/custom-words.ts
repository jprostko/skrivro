// ================= Custom words (personal dictionary) =================
//
// A user-maintained list of words the spellchecker should never flag:
// character names, place names, invented terms, domain jargon. Stored as
// a plain text file (custom-words.txt) in the app config dir alongside
// skrivro.conf, one word per line, matched case-insensitively. The file
// itself is the management UI: edit it to bulk add/remove, delete a line
// to drop a word. Within the editor, Vim `zg`/`zug` and the right-click
// menu add/remove the word under the cursor.
//
// This module holds the canonical in-memory list and the dedup, and the
// worker (spellcheck-worker.ts) owns the actual check and gets the list
// pushed to it via setPersonalWords. Persistence goes through the Rust
// read_custom_words / write_custom_words commands, which resolve the
// config dir and create it on first write (mirroring set_session_state).

import { invoke } from "@tauri-apps/api/core";
import { isResetPending } from "../prefs.js";
import { setPersonalWords } from "./index.js";

// lowercased key → original-case word. The map dedupes case-insensitively
// (so "Frodo" and "frodo" can't both be present) while the file preserves
// the casing the user typed.
const customWords = new Map<string, string>();

const list = (): string[] => [...customWords.values()];

/** Case-insensitive membership: the right-click menu uses this to choose
 *  between "Add to dictionary" and "Remove from dictionary". */
export const hasCustomWord = (word: string): boolean => customWords.has(word.trim().toLowerCase());

// Read the file into the in-memory map. The Rust command resolves the
// path and returns [] when the file is absent, so a missing file is just
// an empty list. Does NOT touch the worker: call syncCustomWordsToWorker
// once the worker is ready (see main.ts).
export const loadCustomWords = async (): Promise<void> => {
  try {
    const words = await invoke<string[]>("read_custom_words");
    customWords.clear();
    for (const w of words) {
      const t = w.trim();
      if (t) customWords.set(t.toLowerCase(), t);
    }
  } catch (e) {
    console.error("[custom-words] read failed:", e);
  }
};

/** Push the current list into the worker (which refreshes the squiggles).
 *  Called once the worker is ready, after loadCustomWords. */
export const syncCustomWordsToWorker = (): void => setPersonalWords(list());

// Sync to the worker (immediate squiggle refresh) and rewrite the file.
// After a factory reset the file write is skipped: the reset blanked
// custom-words.txt, and re-persisting the live list would undo that
// before the restart. The worker sync stays, so the running session
// keeps behaving as it did, same policy as the prefs guard.
const persist = async (): Promise<void> => {
  setPersonalWords(list());
  if (isResetPending()) return;
  try {
    await invoke("write_custom_words", { words: list() });
  } catch (e) {
    console.error("[custom-words] write failed:", e);
  }
};

/** Add a word. Returns false if blank or already present (case-insensitively). */
export const addCustomWord = async (word: string): Promise<boolean> => {
  const t = word.trim();
  if (!t || customWords.has(t.toLowerCase())) return false;
  customWords.set(t.toLowerCase(), t);
  await persist();
  return true;
};

/** Remove a word. Returns false if it wasn't in the list. */
export const removeCustomWord = async (word: string): Promise<boolean> => {
  if (!customWords.delete(word.trim().toLowerCase())) return false;
  await persist();
  return true;
};
