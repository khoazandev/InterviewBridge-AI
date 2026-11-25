const fs = require('fs');
const path = require('path');
const { getConfigDir } = require('../storage');

let cachedPath = null;
let cachedMtimeMs = -1;
let cachedCompiled = null;

function clearPlaybookCache() {
    cachedPath = null;
    cachedMtimeMs = -1;
    cachedCompiled = null;
}

function getPlaybookPath() {
    const configPlaybook = path.join(getConfigDir(), 'playbook.json');
    if (fs.existsSync(configPlaybook)) {
        return configPlaybook;
    }
    const repoPlaybook = path.resolve(__dirname, '../../../user-data/playbook.json');
    if (fs.existsSync(repoPlaybook)) {
        return repoPlaybook;
    }
    return null;
}

function compileRegexList(list) {
    if (!Array.isArray(list)) return [];
    const compiled = [];
    for (const pattern of list) {
        try {
            compiled.push(new RegExp(pattern, 'i'));
        } catch (err) {
            console.warn('[Playbook] Invalid regex pattern skipped:', pattern, err.message);
        }
    }
    return compiled;
}

function loadPlaybook() {
    const filePath = getPlaybookPath();
    if (!filePath) return [];

    try {
        const stat = fs.statSync(filePath);
        if (cachedCompiled && cachedPath === filePath && cachedMtimeMs === stat.mtimeMs) {
            return cachedCompiled;
        }

        const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const entries = Array.isArray(raw?.entries) ? raw.entries : [];
        cachedCompiled = entries.map(entry => ({
            ...entry,
            _patterns: compileRegexList(entry.patterns),
            _excludes: compileRegexList(entry.exclude),
        }));
        cachedPath = filePath;
        cachedMtimeMs = stat.mtimeMs;
        return cachedCompiled;
    } catch (err) {
        console.warn('[Playbook] Failed to load playbook:', err.message);
        return [];
    }
}

function findEntryForSegment(segment, entries) {
    if (!segment) return null;
    for (const entry of entries) {
        if (entry._excludes.some(rx => rx.test(segment))) continue;
        if (entry._patterns.some(rx => rx.test(segment))) {
            return entry;
        }
    }
    return null;
}

function formatPlaybookResponse(entry, enText, viText = '') {
    const cleanEn = String(enText || '').trim();
    const cleanVi = String(viText || '').trim() || entry.viQuestion || '';
    const lines = [
        `**🎧 HR vừa nói (EN):** ${cleanEn}`,
        `**🇻🇳 Dịch nghĩa (VI):** ${cleanVi}`,
    ];
    if (entry.missingNoteVi) {
        lines.push(`*${entry.missingNoteVi}*`);
    }
    lines.push('**⚡ Gợi ý chuẩn Agent (0ms · 100% CV thật):**');
    for (const bullet of entry.bullets || []) {
        lines.push(`- ${bullet}`);
    }
    if (entry.tipVi) {
        lines.push('');
        lines.push(`💡 *Gợi ý nhịp nói:* ${entry.tipVi}`);
    }
    return lines.join('\n');
}

function matchPlaybookAnswer(enText, viText = '') {
    const cleanEn = String(enText || '').replace(/\s+/g, ' ').trim();
    if (!cleanEn) return null;

    const entries = loadPlaybook();
    if (entries.length === 0) return null;

    // Preserve multi-topic compound questions for full LLM synthesis
    const rawSentencesWithPunct = cleanEn.split(/(?<=[.?!])\s+/).filter(Boolean);
    const questionSentences = rawSentencesWithPunct.filter(s => s.includes('?'));
    if (questionSentences.length >= 2) {
        const distinctIds = new Set();
        for (const qs of questionSentences) {
            const matched = findEntryForSegment(qs, entries);
            if (matched) distinctIds.add(matched.id);
        }
        if (distinctIds.size >= 2 || distinctIds.size === 0) {
            return null;
        }
    }

    const segments = cleanEn
        .split(/[.?!]+/)
        .map(s => s.trim())
        .filter(Boolean);
    const lastSentence = segments.length > 0 ? segments[segments.length - 1] : cleanEn;
    const lastTwoSentences = segments.length >= 2 ? segments.slice(-2).join(' ') : cleanEn;
    const wordCount = cleanEn.split(/\s+/).length;

    const candidates = [lastSentence, lastTwoSentences];
    if (wordCount <= 35 && !candidates.includes(cleanEn)) {
        candidates.push(cleanEn);
    }

    for (const candidate of candidates) {
        const matched = findEntryForSegment(candidate, entries);
        if (matched) {
            return formatPlaybookResponse(matched, cleanEn, viText);
        }
    }

    return null;
}

module.exports = {
    matchPlaybookAnswer,
    clearPlaybookCache,
};
