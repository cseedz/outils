// ─── FDX PARSER — partagé entre tous les outils ──────────────────────────────
// Fonctions pures, pas de dépendance vers l'UI ni vers l'état des pages.

function parseEp(sc) {
  const s = String(sc), dot = s.indexOf('.');
  if (dot === -1) {
    const m = s.match(/^(\d+)([A-Za-z]?)$/);
    return { ep: 0, scNum: m ? parseInt(m[1]) : (parseFloat(s) || 0), suffix: m ? m[2].toUpperCase() : '' };
  }
  const after = s.slice(dot + 1);
  const m = after.match(/^(\d+)([A-Za-z]?)$/);
  return { ep: parseInt(s.slice(0, dot)) || 0, scNum: m ? parseInt(m[1]) : (parseFloat(after) || 0), suffix: m ? m[2].toUpperCase() : '' };
}

function fmtEp(sc) { const {ep}=parseEp(sc); return ep>0?'E'+String(ep).padStart(2,'0'):'—'; }

const _JN_RE = /^(JOUR|SOIR|NUIT|MATIN|AUBE|CRÉPUSCULE|FIN DE JOURNÉE|CONTINU[E]?)$/i;

// Termes de production qui ressemblent à une note de distribution en majuscules
// ("FLASHBACK", "MONTAGE"…) mais qui n'en sont pas — filet de sécurité pour la
// convention sans parenthèses, qui n'a pas d'autre marqueur syntaxique.
const _GENERAL_NOTE_BLOCKLIST = new Set([
  'FLASHBACK', 'FLASH-BACK', 'MONTAGE', 'INSERT', 'SUITE', 'FIN', 'NOIR',
  'TRANSITION', 'GÉNÉRIQUE', 'PRÉCÉDEMMENT', 'RAPPEL',
]);

// Sépare une réplique de dialogue groupé en noms individuels — convention FD
// informelle pour du dialogue simultané : un seul paragraphe Character contenant
// plusieurs noms, ex. "Thomas, Zack et Louis" au lieu d'un vrai DualDialogue.
function _splitCharacterNames(raw) {
  let text = raw.replace(/\s*\(.*?\)\s*$/, '').trim();
  text = text.replace(/\s+et\s+/gi, ', ').replace(/&/g, ',');
  return text.split(',').map(p => p.trim().toUpperCase()).filter(n => n.length >= 2);
}

function _detectFdxOptions(xmlString) {
  const doc = new DOMParser().parseFromString(xmlString, 'application/xml');
  const paras = Array.from(doc.querySelectorAll('Paragraph[Type="Scene Heading"]'));
  let dashSubCount = 0;
  const nums = [];
  paras.forEach(p => {
    const n = p.getAttribute('Number') || '';
    if (n) nums.push(n);
    const text = Array.from(p.querySelectorAll('Text')).map(t => t.textContent).join('').trim();
    const rest = text.replace(/^(INT\.?\/EXT\.?|EXT\.?\/INT\.?|INT\.?|EXT\.?)\s*\.?\s*/i, '').trim();
    if (!rest.includes('/') && !rest.includes('(')) {
      const segs = rest.split(/\s+[–—\-]\s+/);
      if (segs.length >= 3 && _JN_RE.test(segs[segs.length - 1].trim())) dashSubCount++;
    }
  });
  const hasCompact = nums.some(n => /^\d{3,4}$/.test(n) && parseInt(n) >= 100);
  const hasDot    = nums.some(n => /^\d+\.\d+$/.test(n));
  return { suggestDash: dashSubCount >= 2, hasCompactNums: hasCompact && !hasDot, isSeries: hasCompact || hasDot };
}

function _fdxParseHeading(text, opts = {}) {
  text = text.replace(/\xa0/g,' ').replace(/\s+/g,' ').trim();
  text = text.replace(/\s*\*{1,2}\s*[A-ZÀ-Ü\s]+$/, '').trim();
  const ieM = text.match(/^(INT\.?\/EXT\.?|EXT\.?\/INT\.?|INT\.?EXT\.?|EXT\.?INT\.?|INT\.?|EXT\.?)\s*\.?\s*/i);
  let int_ext = '—', rest = text;
  if (ieM) {
    int_ext = ieM[1].toUpperCase().replace(/\./g,'').replace(/INTEXT/,'INT/EXT').replace(/EXTINT/,'EXT/INT');
    rest = text.slice(ieM[0].length).trim();
  }
  let lieu = '', sous_lieu = '', jn = '—';
  if (opts.sep === 'dash') {
    const segs = rest.split(/\s+[–—\-]\s+/);
    lieu = segs[0].trim().toUpperCase();
    if (segs.length >= 3) {
      sous_lieu = segs.slice(1, -1).join(' / ').trim().toUpperCase();
      jn = segs[segs.length - 1].trim().toUpperCase();
    } else if (segs.length === 2) {
      jn = segs[1].trim().toUpperCase();
    }
  } else {
    const segs = rest.split(/\s+[-–]\s+/);
    const locationRaw = segs[0].trim();
    jn = segs[1] ? segs[1].split(/\s+[-–]\s+/)[0].trim().toUpperCase() : '—';
    const slashPos = locationRaw.indexOf('/');
    const parenPos = locationRaw.indexOf('(');
    if (slashPos !== -1 && (parenPos === -1 || slashPos < parenPos)) {
      const parts = locationRaw.split('/', 2);
      lieu = parts[0].trim().toUpperCase();
      sous_lieu = parts[1].replace(/\s*\(.*\)\s*$/, '').trim().toUpperCase();
    } else if (parenPos !== -1) {
      const m = locationRaw.match(/^(.+?)\s*\((.+)\)\s*$/);
      if (m) { lieu = m[1].trim().toUpperCase(); sous_lieu = m[2].trim().toUpperCase(); }
      else { lieu = locationRaw.trim().toUpperCase(); sous_lieu = ''; }
    } else {
      lieu = locationRaw.trim().toUpperCase();
      sous_lieu = '';
    }
  }
  return { int_ext, lieu, sous_lieu, jn };
}

// Aplati les <DualDialogue><Paragraph>…</Paragraph>…</DualDialogue> dans la liste
// de paragraphes au niveau du <Content> — sinon les Character/Dialogue imbriqués
// dans un échange en dialogue double sont invisibles au scan scène par scène.
function _flattenParagraphs(content) {
  const flat = [];
  for (const child of content.children) {
    if (child.tagName === 'Paragraph') flat.push(child);
    else if (child.tagName === 'DualDialogue') {
      Array.from(child.children).forEach(p => { if (p.tagName === 'Paragraph') flat.push(p); });
    }
  }
  return flat;
}

function parseFDXToScenes(xmlString, opts = {}) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlString, 'application/xml');
  const parseErr = doc.querySelector('parsererror');
  if (parseErr) throw new Error('XML invalide : ' + (parseErr.textContent || '').slice(0, 120));
  const content = doc.querySelector('Content');
  if (!content) throw new Error('Aucun bloc <Content> dans ce fichier FDX');
  const paragraphs = _flattenParagraphs(content);
  const errors = [], scenes = [];
  const seenNums = new Set();
  let noPropsCount = 0;
  for (let i = 0; i < paragraphs.length; i++) {
    const para = paragraphs[i];
    if (para.getAttribute('Type') !== 'Scene Heading') continue;
    let number = para.getAttribute('Number') || '';
    if (opts.serieFormat === 'compact' && /^\d{3,4}$/.test(number)) {
      const n = parseInt(number);
      const sc_num = n % 100;
      const ep_num = Math.floor(n / 100);
      number = ep_num + '.' + String(sc_num).padStart(2, '0');
    }
    const props = para.querySelector('SceneProperties');
    if (!props) noPropsCount++;
    const page  = props ? (props.getAttribute('Page')   || '0') : '0';
    const duree = props ? (props.getAttribute('Length') || '0') : '0';
    const rawText = Array.from(para.querySelectorAll('Text')).map(t => t.textContent||'').join('').trim();
    if (!rawText) { errors.push(`Scène ${number||'?'} : en-tête vide`); continue; }
    const { int_ext, lieu, sous_lieu, jn } = _fdxParseHeading(rawText, opts);
    if (!lieu || lieu === '—') errors.push(`Scène ${number} : lieu vide (${rawText.slice(0,60)})`);
    if (seenNums.has(number)) errors.push(`Doublon : scène ${number}`);
    seenNums.add(number);
    const bodyParts = [];
    const charLines = {};
    const charPresentSet = new Set();
    // Personnages tagués manuellement dans Final Draft (SceneArcBeats > CharacterArcBeat)
    // — certains tags sont groupés ("Thomas, Zack et Louis") en plus des tags
    // individuels déjà présents pour la même scène ; on les scinde pour ne pas
    // créer un faux personnage composite en double des noms individuels.
    if (props) {
      Array.from(props.querySelectorAll('SceneArcBeats > CharacterArcBeat')).forEach(b => {
        const raw = (b.getAttribute('Name') || '').trim();
        if (raw) _splitCharacterNames(raw).forEach(name => charPresentSet.add(name));
      });
    }
    for (let j = i + 1; j < paragraphs.length; j++) {
      const next = paragraphs[j];
      if (next.getAttribute('Type') === 'Scene Heading') break;
      const type = next.getAttribute('Type') || '';
      const t = Array.from(next.querySelectorAll('Text')).map(n => n.textContent||'').join('').trim();
      if (!t) continue;
      if (type === 'Character') {
        _splitCharacterNames(t).forEach(name => { charLines[name] = (charLines[name] || 0) + 1; });
        bodyParts.push((bodyParts.length ? '\n' : '') + t.toUpperCase() + ' :');
      } else if (type === 'General') {
        bodyParts.push(t);
        // Note de distribution manuelle — deux conventions : "(Nom, Nom)" entre
        // parenthèses, ou "NOM, NOM" en majuscules sans parenthèses (PT S1-2, RF, PT S4)
        const castM = t.match(/^\((.+)\)$/);
        let castBody = null;
        if (castM) {
          castBody = castM[1];
        } else if (!t.trim().endsWith(':')) {
          const skeleton = t.replace(/\([^)]*\)/g, '');
          const letters = skeleton.replace(/[^A-Za-zÀ-ÿ]/g, '');
          if (letters && letters === letters.toUpperCase() && !/[.!?;]/.test(skeleton)) castBody = t;
        }
        if (castBody) {
          // Normaliser les énumérations à la française ("Thomas, Zack et Louis")
          castBody = castBody.replace(/\s+et\s+/gi, ', ').replace(/&/g, ',');
          castBody.split(',').forEach(part => {
            const name = part.replace(/\(.*?\)/g, '').trim().toUpperCase();
            if (name && name.length >= 2 && name.length < 50 && !_GENERAL_NOTE_BLOCKLIST.has(name)) charPresentSet.add(name);
          });
        }
      } else if (type === 'Parenthetical') {
        bodyParts.push('(' + t + ')');
      } else if (type === 'Dialogue' || type === 'Action') {
        bodyParts.push(t);
      }
    }
    Object.keys(charLines).forEach(n => charPresentSet.add(n));
    const charPresent = [...charPresentSet];
    scenes.push({ sc: number, int_ext, lieu, sous_lieu: sous_lieu || '', jn, page, duree, text: bodyParts.join('\n'), charLines, charPresent });
  }
  if (scenes.length && noPropsCount === scenes.length) {
    errors.unshift(`⚠ Aucune pagination trouvée dans ce fichier (SceneProperties absent) — pages et durées seront à 0 pour ${noPropsCount} scène${noPropsCount>1?'s':''}. Dans Final Draft : Fichier → Aperçu avant impression (ou Imprimer), sauvegarde, puis réimporte.`);
  } else if (noPropsCount > 0) {
    errors.unshift(`⚠ ${noPropsCount} scène${noPropsCount>1?'s':''} sans pagination (page/durée à 0) — repagine le document dans Final Draft avant de réexporter.`);
  }
  return { scenes, errors };
}

// Clé de dédoublonnage sûre pour une Map de scènes : `sc` seul ne suffit pas
// car Final Draft laisse souvent le numéro vide sur des scènes pas encore
// renumérotées — sans repli sur l'index, toutes les scènes sans numéro
// s'écrasent en une seule entrée dans la Map.
function _sceneMapKey(s, i) {
  const n = String(s.sc || '').trim();
  return n ? n : '__unnumbered_' + i;
}

function diffScenes(oldRaw, newRaw) {
  const oldMap = new Map((oldRaw||[]).map((s, i) => [_sceneMapKey(s, i), s]));
  const newMap = new Map(newRaw.map((s, i) => [_sceneMapKey(s, i), s]));
  const added=[], removed=[], modified=[], unchanged=[];
  for (const [sc, ns] of newMap) {
    const os = oldMap.get(sc);
    if (!os) { added.push(ns); }
    else {
      const changed = os.lieu!==ns.lieu || os.sous_lieu!==ns.sous_lieu ||
                      os.jn!==ns.jn || os.page!==ns.page ||
                      os.duree!==ns.duree || os.int_ext!==ns.int_ext;
      if (changed) modified.push({ old: os, new: ns }); else unchanged.push(ns);
    }
  }
  for (const [sc, os] of oldMap) { if (!newMap.has(sc)) removed.push(os); }
  return { added, removed, modified, unchanged };
}

function _scSort(a, b) {
  const ae = parseEp(a.sc), be = parseEp(b.sc);
  if (ae.ep !== be.ep) return ae.ep - be.ep;
  // Page number = primary story-order indicator; scene number is fallback only
  const ap = parseFloat(a.page) || 0, bp = parseFloat(b.page) || 0;
  if (ap !== bp) return ap - bp;
  if (ae.scNum !== be.scNum) return ae.scNum - be.scNum;
  return ae.suffix.localeCompare(be.suffix);
}
