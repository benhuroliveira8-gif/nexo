// Tradução de mensagens. Usa o tradutor que já vem no Chrome do computador (roda no
// próprio aparelho, nada sai daqui). Onde não tem, abre o Google Tradutor numa aba nova.
const results = new Map(); // id da mensagem -> { text, from } | { loading } | { error }

const LANG_NAMES = {
  en: 'inglês', es: 'espanhol', fr: 'francês', de: 'alemão', it: 'italiano', ja: 'japonês', ko: 'coreano',
  zh: 'chinês', ru: 'russo', ar: 'árabe', hi: 'hindi', pt: 'português', nl: 'holandês', pl: 'polonês', tr: 'turco', uk: 'ucraniano',
};
export const langName = (code) => LANG_NAMES[String(code || '').split('-')[0]] || code || 'outro idioma';
const target = () => String(navigator.language || 'pt-BR').split('-')[0] || 'pt';

export const translationOf = (id) => results.get(id) || null;
export const hideTranslation = (id) => results.delete(id);
export const builtinAvailable = () => typeof self !== 'undefined' && 'Translator' in self && 'LanguageDetector' in self;

export function googleUrl(text) {
  return `https://translate.google.com/?sl=auto&tl=${encodeURIComponent(target())}&text=${encodeURIComponent(String(text).slice(0, 4000))}&op=translate`;
}

let detector = null;
const translators = new Map();

// Traduz e guarda o resultado. onDone() é chamado quando terminar (para redesenhar).
export async function translateMessage(m, onDone) {
  const text = String(m.content || '').trim();
  if (!text) return false;
  if (!builtinAvailable()) {
    window.open(googleUrl(text), '_blank', 'noopener');
    return false;
  }
  results.set(m.id, { loading: true });
  onDone();
  try {
    detector = detector || await self.LanguageDetector.create();
    const [best] = await detector.detect(text);
    const from = best && best.detectedLanguage && best.detectedLanguage !== 'und' ? best.detectedLanguage : 'en';
    const to = target();
    if (from.split('-')[0] === to) {
      results.set(m.id, { same: true, from });
    } else {
      const key = `${from}>${to}`;
      const avail = await self.Translator.availability({ sourceLanguage: from, targetLanguage: to });
      if (avail === 'unavailable') throw new Error('par indisponível');
      if (!translators.has(key)) translators.set(key, self.Translator.create({ sourceLanguage: from, targetLanguage: to }));
      const tr = await translators.get(key);
      results.set(m.id, { text: await tr.translate(text), from });
    }
  } catch {
    results.delete(m.id);
    window.open(googleUrl(text), '_blank', 'noopener');
  }
  onDone();
  return true;
}
