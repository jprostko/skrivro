// Ambient type declaration for `nspell` (the package ships no types).
// Only the surface Skrivro uses is declared; extend as needed.
declare module 'nspell' {
  export interface NSpell {
    /** True if the word is spelled correctly. */
    correct(word: string): boolean;
    /** Suggested corrections for a (presumably misspelled) word. */
    suggest(word: string): string[];
    /** Add a word to the runtime dictionary. Returns the instance. */
    add(word: string, model?: string): NSpell;
    /** Remove a word from the runtime dictionary. Returns the instance. */
    remove(word: string): NSpell;
    /** Add another dictionary document (shares the affix). */
    dictionary(dic: string): NSpell;
    /** Add a personal dictionary. */
    personal(dic: string): NSpell;
  }

  interface NSpellConstructor {
    (aff: string, dic: string): NSpell;
    (dictionary: { aff: string; dic: string }): NSpell;
  }

  const nspell: NSpellConstructor;
  export default nspell;
}
