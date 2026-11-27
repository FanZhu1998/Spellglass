// The second line of defense for voice (Section 7.6): a fuzzy matcher that does not depend on phrase
// hints. Speech recognizers turn invented words into near-sounding English ("knocks" for Nox,
// "aloha mora" for Alohomora), so every spell lists such mishearings as `heard_as`, and this matcher
// compares the transcript with the incantation and those lists.
//
// How it works, in plain terms:
//  1. Text is normalized: lower case, accents removed, letters only, split into words.
//  2. Each word also gets a simple phonetic key, so spellings that sound alike compare equal
//     ("nocks", "knocks" and "nox" all become nOks; "loo moss" and "lumos" both become lOmOs).
//  3. Windows of consecutive transcript words are compared with every phrase of every spell. A window
//     is one to three words long (Section 7.6 brief), and may be up to one word longer than the phrase
//     it is compared with: some heard_as entries have four words ("a low ha mora"), and a recognizer
//     may split one word in two ("wing gardium"). Word boundaries do not matter inside a window.
//  4. Similarity is an edit-distance ratio on the phonetic keys, helped by the same ratio on the raw
//     letters, and made stricter for short words: one changed sound in "box" is a different word,
//     one changed sound in "expelliarmus" is a mishearing.
//
// Everything here is pure and deterministic, so it is unit-tested against every incantation and
// every heard_as entry in the seed packs (fuzzy.test.ts).

/** Words of a transcript: lower case, accents removed, letters a to z only. */
export function normalizeWords(text: string): string[] {
  if (typeof text !== 'string' || !text) return [];
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

// ------------------------------------------------------------------------------- phonetic key

const VOWELS = new Set(['a', 'e', 'i', 'o', 'u']);
const isVowelLetter = (c: string | undefined): boolean => c !== undefined && VOWELS.has(c);
const isSoftener = (c: string | undefined): boolean => c === 'e' || c === 'i' || c === 'y';

/** Vowel symbols in keys: three classes, because recognizers swap vowels within them most often. */
const VOWEL_CLASS: Record<string, string> = { a: 'A', e: 'E', i: 'E', y: 'E', o: 'O', u: 'O' };

/**
 * A simple phonetic key for one word (original, loosely after the Metaphone family): sounds that
 * recognizers confuse or that English spells several ways collapse to one symbol.
 *  - c, k, ck, q → k (c and g soften to s and j before e, i, y); x → ks; z → s; ph → f;
 *    sh → S, ch and tch → C, th → t, dg(e) → j, qu → kw.
 *  - Silent starts: kn, gn, pn → n; wr → r; ps → s; wh → w.
 *  - h is kept only before a vowel at the start or between vowels; w only before a vowel (so "low"
 *    and "now" end in a vowel, as they sound).
 *  - Vowels fall into three classes (a; e i y; o u); a y that starts a word before a vowel is a
 *    consonant. A final e after a consonant is silent when the word has another vowel ("reduce",
 *    "more", "close"). Repeated symbols collapse ("muffle" → mOfl, "loomos" → lOmOs).
 */
export function phoneticKey(word: string): string {
  let w = word;
  if (/^(kn|gn|pn)/.test(w)) w = w.slice(1);
  else if (w.startsWith('wr')) w = w.slice(1);
  else if (w.startsWith('ps')) w = w.slice(1);
  else if (w.startsWith('wh')) w = 'w' + w.slice(2);
  else if (w.startsWith('x')) w = 's' + w.slice(1);
  const last = w.length - 1;
  const silentE = last >= 2 && w[last] === 'e' && !isVowelLetter(w[last - 1]) && w[last - 1] !== 'y' && /[aeiouy]/.test(w.slice(0, last - 1));
  const out: string[] = [];
  const push = (s: string) => {
    if (out[out.length - 1] !== s) out.push(s);
  };
  for (let i = 0; i < w.length; i++) {
    const c = w[i];
    const n = w[i + 1];
    const prev = w[i - 1];
    if (isVowelLetter(c)) {
      // The silent e is skipped here, after it has softened a c or g before it ("reduce" → rEdOs).
      if (!(silentE && i === last)) push(VOWEL_CLASS[c]);
      continue;
    }
    switch (c) {
      case 'y':
        if (i === 0 && isVowelLetter(n)) push('y');
        else push('E');
        break;
      case 'c':
        if (n === 'h') { push('C'); i++; }
        else if (n === 'k') { push('k'); i++; }
        else push(isSoftener(n) ? 's' : 'k');
        break;
      case 'g':
        if (n === 'h') { if (i === 0) push('g'); i++; }
        else push(isSoftener(n) ? 'j' : 'g');
        break;
      case 'p':
        if (n === 'h') { push('f'); i++; }
        else push('p');
        break;
      case 's':
        if (n === 'h') { push('S'); i++; }
        else if (n === 'c' && w[i + 2] === 'h') { push('s'); push('k'); i += 2; }
        else push('s');
        break;
      case 't':
        if (n === 'h') { push('t'); i++; }
        else if (n === 'c' && w[i + 2] === 'h') { push('C'); i += 2; }
        else push('t');
        break;
      case 'd':
        if (n === 'g' && isSoftener(w[i + 2])) { push('j'); i++; }
        else push('d');
        break;
      case 'q':
        push('k');
        if (n === 'u') { push('w'); i++; }
        break;
      case 'x':
        push('k');
        push('s');
        break;
      case 'z':
        push('s');
        break;
      case 'h':
        if ((i === 0 || isVowelLetter(prev)) && isVowelLetter(n)) push('h');
        break;
      case 'w':
        if (isVowelLetter(n)) push('w');
        break;
      default:
        push(c);
    }
  }
  return out.join('');
}

// ------------------------------------------------------------------------------- distance

/** Vowels in a phonetic key are the three class symbols; a lower-case y in a key is a consonant. */
const isVowelSymbol = (s: string): boolean => s === 'A' || s === 'E' || s === 'O';

/** Pairs of consonants that recognizers mix up (voiced and unvoiced twins, nasals, s and sh...). */
const SIMILAR = new Set(
  ['mn', 'bp', 'dt', 'gk', 'fv', 'sS', 'SC', 'Cj', 'gj', 'ck', 'cs', 'kq', 'sz']
    .flatMap((p) => [p, p[1] + p[0]]),
);

/** Edits that touch the first sound cost this much more: rhymes ("box", "socks") are other words. */
const START_WEIGHT = 1.5;
/** Short strings get stricter: the ratio is scaled by (1 + SHORT / length). */
const SHORT = 2.5;
/** Adding or dropping a final s costs this little: recognizers add and drop plural and possessive
 *  endings freely ("knock" for "knocks", "lumo" for "lumos"). */
const FINAL_S = 0.5;

/** Weight of one symbol: vowels count half, because they are the least reliable part of a transcript. */
function symbolWeight(s: string, vowel: (s: string) => boolean): number {
  return vowel(s) ? 0.5 : 1;
}

function weightOf(s: string, vowel: (s: string) => boolean): number {
  let w = 0;
  for (const c of s) w += symbolWeight(c, vowel);
  return w;
}

/**
 * Weighted edit distance: inserting or deleting a vowel costs 0.5 and a consonant 1 (a final s
 * FINAL_S); swapping two vowels costs 0.5, two similar consonants 0.6, anything else 1; edits at the
 * first symbol cost START_WEIGHT times more.
 */
export function weightedDistance(a: string, b: string, vowel: (s: string) => boolean = isVowelSymbol): number {
  const n = a.length;
  const m = b.length;
  if (n === 0) return weightOf(b, vowel) * (m ? START_WEIGHT : 1);
  if (m === 0) return weightOf(a, vowel) * START_WEIGHT;
  /** Cost of inserting or deleting symbol s at position k (1-based) of a string of length len. */
  const indel = (s: string, k: number, len: number): number => {
    if (k === len && k > 1 && s === 's') return FINAL_S;
    return symbolWeight(s, vowel) * (k === 1 ? START_WEIGHT : 1);
  };
  let prev = new Float64Array(m + 1);
  let cur = new Float64Array(m + 1);
  prev[0] = 0;
  for (let j = 1; j <= m; j++) prev[j] = prev[j - 1] + indel(b[j - 1], j, m);
  for (let i = 1; i <= n; i++) {
    const ai = a[i - 1];
    const wa = indel(ai, i, n);
    cur[0] = prev[0] + wa;
    for (let j = 1; j <= m; j++) {
      const bj = b[j - 1];
      const atStart = i === 1 || j === 1;
      let sub = 0;
      if (ai !== bj) {
        const va = vowel(ai);
        const vb = vowel(bj);
        if (va && vb) sub = 0.5;
        // Similar consonants are cheap inside a word, never as the first sound ("mocks" is not "nocks").
        else if (!va && !vb && !atStart && SIMILAR.has(ai + bj)) sub = 0.6;
        else sub = 1;
        if (atStart) sub *= START_WEIGHT;
      }
      const del = prev[j] + wa;
      const ins = cur[j - 1] + indel(bj, j, m);
      cur[j] = Math.min(del, ins, prev[j - 1] + sub);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[m];
}

const isRawVowel = (s: string): boolean => VOWELS.has(s) || s === 'y';

/** 0..1 similarity from a weighted distance, stricter for short strings. */
function ratio(cost: number, wa: number, wb: number): number {
  const w = Math.max(wa, wb);
  if (w <= 0) return 0;
  const r = (cost / w) * (1 + SHORT / w);
  return r >= 1 ? 0 : 1 - r;
}

/** A phrase or a transcript window, ready to compare. */
export interface Form {
  /** Letters only, no spaces. */
  letters: string;
  /** Phonetic key of the words, joined, repeats collapsed. */
  key: string;
  words: number;
  /** Weights of letters and key, cached for the length filter. */
  wLetters: number;
  wKey: number;
}

export function formOfWords(words: readonly string[]): Form | null {
  if (!words.length) return null;
  const letters = words.join('');
  if (!letters) return null;
  const key = collapse(words.map(phoneticKey).join(''));
  return { letters, key, words: words.length, wLetters: weightOf(letters, isRawVowel), wKey: weightOf(key, isVowelSymbol) };
}

export function formOf(text: string): Form | null {
  return formOfWords(normalizeWords(text));
}

function collapse(s: string): string {
  let out = '';
  for (const c of s) if (out[out.length - 1] !== c) out += c;
  return out;
}

/**
 * Similarity of two forms, 0..1. The phonetic key decides ("sounds like"); the raw letters may
 * lift the score by half of what they add, which helps spellings the key treats too strictly.
 */
export function similarity(a: Form, b: Form): number {
  if (a.letters === b.letters) return 1;
  const key = a.key === b.key ? 1 : ratio(weightedDistance(a.key, b.key, isVowelSymbol), a.wKey, b.wKey);
  if (key >= 1) return 1;
  const raw = ratio(weightedDistance(a.letters, b.letters, isRawVowel), a.wLetters, b.wLetters);
  return raw > key ? key + (raw - key) / 2 : key;
}

/** The best similarity two forms could reach, from their lengths alone: the cost is at least the
 *  difference in weight, less what a cheap final s can save at either end. Used to skip
 *  comparisons that cannot matter. */
function bound(a: Form, b: Form): number {
  const slack = 2 * (1 - FINAL_S);
  const kb = ratio(Math.max(0, Math.abs(a.wKey - b.wKey) - slack), a.wKey, b.wKey);
  const rb = ratio(Math.max(0, Math.abs(a.wLetters - b.wLetters) - slack), a.wLetters, b.wLetters);
  return Math.max(kb, rb);
}

// ------------------------------------------------------------------------------- matching

export interface PhraseForm extends Form {
  /** The phrase as written in the pack. */
  text: string;
  source: 'incantation' | 'heard_as';
}

/** One spell's phrases: its incantation first, then its heard_as list. */
export interface SpellForms {
  spellId: string;
  phrases: PhraseForm[];
}

export function spellForms(spellId: string, incantation: string, heardAs: readonly unknown[] | undefined): SpellForms {
  const phrases: PhraseForm[] = [];
  const seen = new Set<string>();
  const add = (text: unknown, source: PhraseForm['source']) => {
    if (typeof text !== 'string') return;
    const f = formOf(text);
    if (!f || seen.has(f.letters)) return;
    seen.add(f.letters);
    phrases.push({ ...f, text: text.trim(), source });
  };
  add(incantation, 'incantation');
  for (const h of heardAs ?? []) add(h, 'heard_as');
  return { spellId, phrases };
}

export interface SpellMatch {
  spellId: string;
  /** Similarity of the best window to the best phrase, 0..1. */
  score: number;
  /** The phrase it matched, as written in the pack. */
  phrase: string;
  /** Word positions of the matched window in the transcript, [from, to). */
  from: number;
  to: number;
}

export interface MatchOptions {
  /** Longest window when every phrase is short (default 3, as Section 7.6 asks: one to three words). */
  maxWords?: number;
  /** Only the last this many transcript words are read (long dictation would cost too much). */
  lastWords?: number;
  /** Matches below this are not reported. */
  floor?: number;
}

export const MATCH_DEFAULTS: Required<MatchOptions> = { maxWords: 3, lastWords: 24, floor: 0.3 };

/**
 * A heard_as entry is already an approximation of the incantation, so a fuzzy match to one is weaker
 * evidence than the same match to the incantation: it is scaled by this. An exact match still
 * scores 1. ("lock" is one step from the listed "locks", two from "Nox": it should not cast Nox.)
 */
export const HEARD_AS_FUZZY_FACTOR = 0.6;

/**
 * Score a transcript against every spell. Returns one match per spell that reaches the floor, best
 * first; on equal scores the later window wins (the most recent words). Pure.
 */
export function matchTranscript(text: string, spells: readonly SpellForms[], options: MatchOptions = {}): SpellMatch[] {
  const o = { ...MATCH_DEFAULTS, ...options };
  const all = normalizeWords(text);
  const offset = Math.max(0, all.length - o.lastWords);
  const words = all.slice(offset);
  if (!words.length || !spells.length) return [];
  const longest = Math.max(o.maxWords, ...spells.flatMap((s) => s.phrases.map((p) => p.words)));

  // Every window once, with its form.
  const windows: { from: number; to: number; form: Form }[] = [];
  for (let len = 1; len <= Math.min(longest, words.length); len++) {
    for (let i = 0; i + len <= words.length; i++) {
      const form = formOfWords(words.slice(i, i + len));
      if (form) windows.push({ from: i + offset, to: i + len + offset, form });
    }
  }

  const out: SpellMatch[] = [];
  for (const spell of spells) {
    let best: SpellMatch | null = null;
    for (const phrase of spell.phrases) {
      // A window may be up to three words, or as long as the phrase (plus one, for a split word).
      const maxLen = Math.max(o.maxWords, phrase.words + 1);
      for (const w of windows) {
        if (w.to - w.from > maxLen) continue;
        if (bound(w.form, phrase) < o.floor) continue;
        let score = similarity(w.form, phrase);
        if (score < 1 && phrase.source === 'heard_as') score *= HEARD_AS_FUZZY_FACTOR;
        if (score < o.floor) continue;
        if (!best || score > best.score + 1e-9 || (Math.abs(score - best.score) <= 1e-9 && w.from > best.from)) {
          best = { spellId: spell.spellId, score, phrase: phrase.text, from: w.from, to: w.to };
        }
      }
    }
    if (best) out.push(best);
  }
  out.sort((a, b) => b.score - a.score || b.from - a.from);
  return out;
}
