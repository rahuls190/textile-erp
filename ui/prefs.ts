import { DEFAULT_PREFS, PREF_OPTIONS, type Preferences } from '../src/domain/prefs.js';
export { DEFAULT_PREFS, PREF_OPTIONS };
export type { Preferences };

/** Accent colours: [light accent, light soft, dark accent, dark soft, label]. "kalyani" is the brand purple from the website. */
export const ACCENTS: Record<Preferences['accent'], { name: string; l: [string, string]; d: [string, string] }> = {
  kalyani: { name: 'Kalyani purple', l: ['#6f4f9a', '#efe8f7'], d: ['#c3a4ea', '#2e2440'] },
  forest: { name: 'Forest green', l: ['#17634f', '#e3f1ea'], d: ['#5cc6a1', '#183a2d'] },
  ocean: { name: 'Ocean blue', l: ['#1d5c9a', '#e2edf8'], d: ['#86b9ee', '#1a3250'] },
  rose: { name: 'Rose', l: ['#b0365f', '#fae6ee'], d: ['#f08fb0', '#432030'] },
  amber: { name: 'Amber', l: ['#9a5b00', '#faeccd'], d: ['#e3b24a', '#3a2f12'] },
  slate: { name: 'Slate', l: ['#3d4b5c', '#e6eaef'], d: ['#a9b8c9', '#252d38'] },
};

const root = document.documentElement;
let hostTheme: string | null | undefined;   // what the page that hosts us chose, so "system" can hand control back

export function applyPrefs(p: Preferences = DEFAULT_PREFS) {
  if (hostTheme === undefined) hostTheme = root.getAttribute('data-theme');
  if (p.theme === 'system') { hostTheme ? root.setAttribute('data-theme', hostTheme) : root.removeAttribute('data-theme'); }
  else root.setAttribute('data-theme', p.theme);
  const dark = p.theme === 'dark' || (p.theme === 'system' && (hostTheme ? hostTheme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches));
  const a = ACCENTS[p.accent] ?? ACCENTS.kalyani, [acc, soft] = dark ? a.d : a.l;
  root.style.setProperty('--accent', acc); root.style.setProperty('--accent-soft', soft);
  root.style.setProperty('--accent-fg', dark ? '#14101c' : '#ffffff');
  root.setAttribute('data-layout', p.layout); root.setAttribute('data-density', p.density);
}
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => { if (current.theme === 'system') applyPrefs(current); });
let current: Preferences = DEFAULT_PREFS;
export const setCurrent = (p: Preferences) => { current = p; applyPrefs(p); };
export const getCurrent = () => current;
