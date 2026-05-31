// Hangul search utilities — no external dependency needed
// Supports: full Korean, English (case-insensitive), chosung, Korean→English typo
(function() {
  const CHOSUNG = ['ㄱ','ㄲ','ㄴ','ㄷ','ㄸ','ㄹ','ㅁ','ㅂ','ㅃ','ㅅ','ㅆ','ㅇ','ㅈ','ㅉ','ㅊ','ㅋ','ㅌ','ㅍ','ㅎ'];
  const KO_TO_EN = {
    'ㄱ':'r','ㄲ':'R','ㄴ':'s','ㄷ':'e','ㄸ':'E','ㄹ':'f','ㅁ':'a','ㅂ':'q','ㅃ':'Q',
    'ㅅ':'t','ㅆ':'T','ㅇ':'d','ㅈ':'w','ㅉ':'W','ㅊ':'c','ㅋ':'z','ㅌ':'x','ㅍ':'v','ㅎ':'g',
    'ㅏ':'k','ㅐ':'o','ㅑ':'i','ㅒ':'O','ㅓ':'j','ㅔ':'p','ㅕ':'u','ㅖ':'P','ㅗ':'h','ㅘ':'hk',
    'ㅙ':'ho','ㅚ':'hl','ㅛ':'y','ㅜ':'n','ㅝ':'nj','ㅞ':'np','ㅟ':'nl','ㅠ':'b','ㅡ':'m','ㅢ':'ml','ㅣ':'l'
  };

  function getChosung(str) {
    let result = '';
    for (const ch of str) {
      const code = ch.charCodeAt(0) - 0xAC00;
      if (code >= 0 && code <= 11171) {
        result += CHOSUNG[Math.floor(code / 28 / 21)];
      } else {
        result += ch;
      }
    }
    return result;
  }

  function decomposeHangul(str) {
    let result = '';
    for (const ch of str) {
      const code = ch.charCodeAt(0) - 0xAC00;
      if (code >= 0 && code <= 11171) {
        const cho = Math.floor(code / 28 / 21);
        const jung = Math.floor((code / 28) % 21);
        const jong = code % 28;
        result += CHOSUNG[cho];
        // Jung vowels mapping
        const JUNGSUNG = ['ㅏ','ㅐ','ㅑ','ㅒ','ㅓ','ㅔ','ㅕ','ㅖ','ㅗ','ㅘ','ㅙ','ㅚ','ㅛ','ㅜ','ㅝ','ㅞ','ㅟ','ㅠ','ㅡ','ㅢ','ㅣ'];
        const JONGSUNG = ['','ㄱ','ㄲ','ㄳ','ㄴ','ㄵ','ㄶ','ㄷ','ㄹ','ㄺ','ㄻ','ㄼ','ㄽ','ㄾ','ㄿ','ㅀ','ㅁ','ㅂ','ㅄ','ㅅ','ㅆ','ㅇ','ㅈ','ㅊ','ㅋ','ㅌ','ㅍ','ㅎ'];
        result += JUNGSUNG[jung];
        if (jong) result += JONGSUNG[jong];
      } else {
        result += ch;
      }
    }
    return result;
  }

  function koToEn(str) {
    return decomposeHangul(str).split('').map(c => KO_TO_EN[c] || c).join('');
  }

  window.hangulSearch = {
    match(query, target) {
      if (!query) return true;
      const q = query.toLowerCase().trim();
      const t = target.toLowerCase();
      if (t.includes(q)) return true;
      // chosung match
      const cho = getChosung(target);
      if (cho.includes(q)) return true;
      // ko→en typo
      if (koToEn(target).toLowerCase().includes(q)) return true;
      return false;
    }
  };
})();
