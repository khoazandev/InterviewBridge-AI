#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const zlib = require('zlib');
const { execFileSync, spawn } = require('child_process');
const readline = require('readline');

const REPO_SLUG = 'khoazandev/InterviewBridge-AI';
const RELEASE_BASE = `https://github.com/${REPO_SLUG}/releases/latest/download`;
const RAW_BASE = `https://raw.githubusercontent.com/${REPO_SLUG}/main`;
const PKG_ROOT = path.resolve(__dirname, '..');

const DEFAULT_CONFIG = {
    configVersion: 1,
    onboarded: true,
    layout: 'normal',
    geminiLiveModel: 'gemini-3.1-flash-live-preview',
    groqModel: 'qwen/qwen3.6-27b',
    groqImageModel: 'qwen/qwen3.6-27b',
    disableGroqThinking: true,
};

const DEFAULT_CREDENTIALS = {
    apiKey: '',
    groqApiKey: '',
};

const DEFAULT_PREFERENCES = {
    customPrompt: '',
    cvText: '',
    jdText: '',
    hrRole: '',
    hrSalary: '',
    hrNotice: '',
    hrReason: '',
    extraNotes: '',
    providerMode: 'byok',
    selectedProfile: 'hr_bilingual',
    selectedLanguage: 'en-US',
    selectedScreenshotInterval: '5',
    selectedImageQuality: 'medium',
    advancedMode: false,
    audioMode: 'speaker_only',
    fontSize: 'medium',
    backgroundTransparency: 0.8,
    googleSearchEnabled: false,
    localLlmModel: 'unsloth/Qwen3.5-4B-GGUF:Q4_K_M',
    whisperModel: 'tiny.en',
};

function getConfigDir(overrideDir = null) {
    if (overrideDir) return path.resolve(overrideDir);
    if (process.platform === 'win32') {
        return path.join(os.homedir(), 'AppData', 'Roaming', 'interview-bridge-config');
    }
    if (process.platform === 'darwin') {
        return path.join(os.homedir(), 'Library', 'Application Support', 'interview-bridge-config');
    }
    return path.join(os.homedir(), '.config', 'interview-bridge-config');
}

function readJsonSafe(filePath, fallback) {
    try {
        if (fs.existsSync(filePath)) {
            const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            if (parsed && typeof parsed === 'object') return parsed;
        }
    } catch {
        // ignore parse errors
    }
    return { ...fallback };
}

function writeJsonSafe(filePath, data) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function composeCandidateContext(prefs = {}) {
    const hrFacts = [];
    const role = String(prefs.hrRole || '').trim();
    const salary = String(prefs.hrSalary || '').trim();
    const notice = String(prefs.hrNotice || '').trim();
    const reason = String(prefs.hrReason || '').trim();

    if (role) hrFacts.push(`- Role & Company: ${role}`);
    if (salary) hrFacts.push(`- Expected Salary: ${salary}`);
    if (notice) hrFacts.push(`- Notice Period / Availability: ${notice}`);
    if (reason) hrFacts.push(`- Reason for Job Change: ${reason}`);

    const sections = [];
    if (hrFacts.length > 0) sections.push(`=== TARGET ROLE & HR QUICK FACTS ===\n${hrFacts.join('\n')}`);
    const cvText = String(prefs.cvText || '').trim();
    if (cvText) sections.push(`=== CANDIDATE CV / RESUME ===\n${cvText}`);
    const jdText = String(prefs.jdText || '').trim();
    if (jdText) sections.push(`=== TARGET JOB DESCRIPTION (JD) ===\n${jdText}`);
    const extra = String(prefs.extraNotes || '').trim();
    if (extra) sections.push(`=== ADDITIONAL CANDIDATE NOTES ===\n${extra}`);

    if (sections.length === 0) return String(prefs.customPrompt || '').trim();
    return sections.join('\n\n');
}

function extractDocxText(buffer) {
    let eocdOffset = -1;
    const minOffset = Math.max(0, buffer.length - 65557);
    for (let i = buffer.length - 22; i >= minOffset; i--) {
        if (buffer.readUInt32LE(i) === 0x06054b50 && i + 22 + buffer.readUInt16LE(i + 20) <= buffer.length) {
            eocdOffset = i;
            break;
        }
    }
    if (eocdOffset === -1) {
        throw new Error('Invalid DOCX archive (missing End of Central Directory).');
    }

    const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
    let cdOffset = buffer.readUInt32LE(eocdOffset + 16);
    for (let idx = 0; idx < totalEntries && cdOffset + 46 <= buffer.length; idx++) {
        if (buffer.readUInt32LE(cdOffset) !== 0x02014b50) break;
        const method = buffer.readUInt16LE(cdOffset + 10);
        const compressedSize = buffer.readUInt32LE(cdOffset + 20);
        const nameLen = buffer.readUInt16LE(cdOffset + 28);
        const extraLen = buffer.readUInt16LE(cdOffset + 30);
        const commentLen = buffer.readUInt16LE(cdOffset + 32);
        const localHeaderOffset = buffer.readUInt32LE(cdOffset + 42);
        const fileName = buffer.slice(cdOffset + 46, cdOffset + 46 + nameLen).toString('utf8');

        if (fileName === 'word/document.xml') {
            if (buffer.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
                throw new Error('Invalid DOCX local entry header.');
            }
            const lNameLen = buffer.readUInt16LE(localHeaderOffset + 26);
            const lExtraLen = buffer.readUInt16LE(localHeaderOffset + 28);
            const dataStart = localHeaderOffset + 30 + lNameLen + lExtraLen;
            const compressed = buffer.slice(dataStart, dataStart + compressedSize);
            let xml = '';
            if (method === 0) {
                xml = compressed.toString('utf8');
            } else if (method === 8) {
                xml = zlib.inflateRawSync(compressed).toString('utf8');
            } else {
                throw new Error(`Unsupported DOCX compression method: ${method}`);
            }
            return xml
                .replace(/<\/w:p>/g, '\n')
                .replace(/<w:tab\b[^>]*\/>/g, ' ')
                .replace(/<w:br\b[^>]*\/>/g, '\n')
                .replace(/<[^>]+>/g, '')
                .replace(/&amp;/g, '&')
                .replace(/&lt;/g, '<')
                .replace(/&gt;/g, '>')
                .replace(/&quot;/g, '"')
                .replace(/&apos;/g, "'")
                .replace(/\n{3,}/g, '\n\n')
                .trim();
        }
        cdOffset += 46 + nameLen + extraLen + commentLen;
    }
    throw new Error('Could not find word/document.xml inside DOCX file.');
}

function extractDocumentText(filePath) {
    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved)) {
        throw new Error(`File not found: ${resolved}`);
    }
    const ext = path.extname(resolved).toLowerCase();
    if (ext === '.txt' || ext === '.md' || ext === '.json') {
        return fs.readFileSync(resolved, 'utf8').trim();
    }
    if (ext === '.docx') {
        return extractDocxText(fs.readFileSync(resolved));
    }
    if (ext === '.pdf') {
        const scriptPath = path.join(PKG_ROOT, 'scripts', 'context_builder.py');
        let lastErr = null;
        for (const pyCmd of ['python', 'py']) {
            try {
                return execFileSync(pyCmd, [scriptPath, '--extract', resolved], {
                    encoding: 'utf8',
                    maxBuffer: 10 * 1024 * 1024,
                    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
                }).trim();
            } catch (err) {
                lastErr = err;
            }
        }
        throw new Error(
            `PDF extraction requires Python + pypdf (or pass a .docx / .txt / .md file). Details: ${lastErr?.message || 'unknown'}`
        );
    }
    throw new Error(`Unsupported extension '${ext}'. Supported: .pdf, .docx, .txt, .md, .json`);
}

function syncContext(options = {}) {
    const targetDir = getConfigDir(options.configDir);
    fs.mkdirSync(path.join(targetDir, 'history'), { recursive: true });

    const configPath = path.join(targetDir, 'config.json');
    const existingCfg = readJsonSafe(configPath, {});
    if (existingCfg.configVersion !== DEFAULT_CONFIG.configVersion) {
        writeJsonSafe(configPath, { ...DEFAULT_CONFIG, ...existingCfg, configVersion: DEFAULT_CONFIG.configVersion });
    }

    const credsPath = path.join(targetDir, 'credentials.json');
    if (!fs.existsSync(credsPath)) {
        writeJsonSafe(credsPath, DEFAULT_CREDENTIALS);
    }

    const prefsPath = path.join(targetDir, 'preferences.json');
    const prefs = { ...DEFAULT_PREFERENCES, ...readJsonSafe(prefsPath, {}) };

    if (options.cvPath) prefs.cvText = extractDocumentText(options.cvPath);
    if (options.jdPath) prefs.jdText = extractDocumentText(options.jdPath);
    if (options.role !== undefined) prefs.hrRole = String(options.role).trim();
    if (options.salary !== undefined) prefs.hrSalary = String(options.salary).trim();
    if (options.notice !== undefined) prefs.hrNotice = String(options.notice).trim();
    if (options.reason !== undefined) prefs.hrReason = String(options.reason).trim();
    if (options.notes !== undefined) prefs.extraNotes = String(options.notes).trim();
    if (options.mode) prefs.selectedProfile = String(options.mode).trim();

    prefs.customPrompt = composeCandidateContext(prefs);
    writeJsonSafe(prefsPath, prefs);
    return { prefsPath, prefs };
}

function downloadFile(url, destPath, redirectsLeft = 10) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { headers: { 'User-Agent': 'InterviewBridge-AI-CLI' } }, res => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                if (redirectsLeft <= 0) {
                    return reject(new Error(`Too many redirects for ${url}`));
                }
                const nextUrl = new URL(res.headers.location, url).toString();
                return downloadFile(nextUrl, destPath, redirectsLeft - 1).then(resolve, reject);
            }
            if (res.statusCode !== 200) {
                res.resume();
                return reject(new Error(`HTTP ${res.statusCode} downloading ${url}`));
            }
            fs.mkdirSync(path.dirname(destPath), { recursive: true });
            const tmpPath = `${destPath}.part`;
            const file = fs.createWriteStream(tmpPath);
            const totalBytes = parseInt(res.headers['content-length'] || '0', 10);
            let received = 0;

            res.on('data', chunk => {
                received += chunk.length;
                if (process.stdout.isTTY && totalBytes > 0) {
                    const pct = Math.min(100, Math.round((received / totalBytes) * 100));
                    const mb = (received / (1024 * 1024)).toFixed(1);
                    const totalMb = (totalBytes / (1024 * 1024)).toFixed(1);
                    process.stdout.write(`\r  Downloading ${path.basename(destPath)}: ${mb}/${totalMb} MB (${pct}%)`);
                }
            });

            res.pipe(file);
            file.on('finish', () => {
                file.close(() => {
                    if (process.stdout.isTTY && totalBytes > 0) process.stdout.write('\n');
                    fs.renameSync(tmpPath, destPath);
                    resolve(destPath);
                });
            });
            file.on('error', err => {
                fs.rmSync(tmpPath, { force: true });
                reject(err);
            });
        });
        req.on('error', reject);
    });
}

function installSkill({ homeDir = os.homedir() } = {}) {
    const srcSkill = path.join(PKG_ROOT, 'skills', 'interview-bridge', 'SKILL.md');
    const srcScript = path.join(PKG_ROOT, 'scripts', 'context_builder.py');
    if (!fs.existsSync(srcSkill)) {
        throw new Error(`Missing skill source at ${srcSkill}`);
    }

    const targets = [path.join(homeDir, '.agents', 'skills', 'interview-bridge')];
    const claudeDir = path.join(homeDir, '.claude');
    if (fs.existsSync(claudeDir)) {
        targets.push(path.join(claudeDir, 'skills', 'interview-bridge'));
    }

    for (const destRoot of targets) {
        fs.mkdirSync(path.join(destRoot, 'scripts'), { recursive: true });
        fs.copyFileSync(srcSkill, path.join(destRoot, 'SKILL.md'));
        if (fs.existsSync(srcScript)) {
            fs.copyFileSync(srcScript, path.join(destRoot, 'scripts', 'context_builder.py'));
        }
    }
    return targets;
}

async function installApp({ launch = true, destDir = path.join(os.homedir(), 'InterviewBridge-AI') } = {}) {
    if (process.platform !== 'win32') {
        console.log('Prebuilt .exe installers target Windows 11. On macOS/Linux, clone the repo and run `npm start` inside app/.');
        console.log(`Repository: https://github.com/${REPO_SLUG}`);
        return { destDir, downloaded: [] };
    }

    fs.mkdirSync(destDir, { recursive: true });
    const files = [
        { name: 'InterviewBridge-AI-Setup.exe', url: `${RELEASE_BASE}/InterviewBridge-AI-Setup.exe` },
        { name: 'LiveCaptionsTranslator.exe', url: `${RELEASE_BASE}/LiveCaptionsTranslator.exe` },
    ];

    const downloaded = [];
    for (const item of files) {
        const outPath = path.join(destDir, item.name);
        console.log(`Fetching ${item.name}...`);
        await downloadFile(item.url, outPath);
        downloaded.push(outPath);
        console.log(`  Saved -> ${outPath}`);
    }

    const setupExe = path.join(destDir, 'InterviewBridge-AI-Setup.exe');
    if (launch && fs.existsSync(setupExe)) {
        console.log('Launching InterviewBridge-AI-Setup.exe...');
        const child = spawn(setupExe, [], { detached: true, stdio: 'ignore' });
        child.unref();
    }
    return { destDir, downloaded };
}

function getStatus({ homeDir = os.homedir(), configDir = null } = {}) {
    const cfgDir = getConfigDir(configDir);
    const prefs = readJsonSafe(path.join(cfgDir, 'preferences.json'), DEFAULT_PREFERENCES);
    const creds = readJsonSafe(path.join(cfgDir, 'credentials.json'), DEFAULT_CREDENTIALS);

    const skillPaths = [
        path.join(homeDir, '.agents', 'skills', 'interview-bridge', 'SKILL.md'),
        path.join(homeDir, '.claude', 'skills', 'interview-bridge', 'SKILL.md'),
    ];
    const installedSkills = skillPaths.filter(p => fs.existsSync(p));
    const liveCaptionsWin = process.platform === 'win32'
        ? fs.existsSync(path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'LiveCaptions.exe'))
        : false;

    return {
        platform: process.platform,
        liveCaptionsAvailable: liveCaptionsWin,
        installedSkills,
        configDir: cfgDir,
        profile: prefs.selectedProfile || 'hr_bilingual',
        cvChars: String(prefs.cvText || '').trim().length,
        jdChars: String(prefs.jdText || '').trim().length,
        hrRole: String(prefs.hrRole || '').trim(),
        hasGeminiKey: Boolean(String(creds.apiKey || '').trim()),
        hasGroqKey: Boolean(String(creds.groqApiKey || '').trim()),
    };
}

function printStatus(status) {
    console.log('\n=== InterviewBridge AI Status ===');
    console.log(`Platform              : ${status.platform}`);
    console.log(`Windows LiveCaptions  : ${status.liveCaptionsAvailable ? 'Available (Win + Ctrl + L)' : 'N/A or not detected'}`);
    console.log(`Installed Skills      : ${status.installedSkills.length ? status.installedSkills.join(', ') : 'Not installed yet (run: interview-bridge skill)'}`);
    console.log(`App Config Dir        : ${status.configDir}`);
    console.log(`Active Profile        : ${status.profile}`);
    console.log(`Synced CV / JD        : CV ${status.cvChars} chars | JD ${status.jdChars} chars`);
    console.log(`Target Role           : ${status.hrRole || '(not set)'}`);
    console.log(`API Keys Configured   : Gemini=${status.hasGeminiKey ? 'Yes' : 'No'} | Groq=${status.hasGroqKey ? 'Yes' : 'No'}\n`);
}

function buildMinimalDocxBuffer(paragraphs) {
    const bodyXml = paragraphs.map(p => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join('');
    const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${bodyXml}</w:body></w:document>`;
    const nameBuf = Buffer.from('word/document.xml', 'utf8');
    const compressed = zlib.deflateRawSync(Buffer.from(xml, 'utf8'));

    const localHeader = Buffer.alloc(30 + nameBuf.length);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(8, 8);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(Buffer.byteLength(xml, 'utf8'), 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    nameBuf.copy(localHeader, 30);

    const cdOffset = localHeader.length + compressed.length;
    const cdHeader = Buffer.alloc(46 + nameBuf.length);
    cdHeader.writeUInt32LE(0x02014b50, 0);
    cdHeader.writeUInt16LE(20, 4);
    cdHeader.writeUInt16LE(20, 6);
    cdHeader.writeUInt16LE(8, 10);
    cdHeader.writeUInt32LE(compressed.length, 20);
    cdHeader.writeUInt32LE(Buffer.byteLength(xml, 'utf8'), 24);
    cdHeader.writeUInt16LE(nameBuf.length, 28);
    cdHeader.writeUInt32LE(0, 42);
    nameBuf.copy(cdHeader, 46);

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(1, 8);
    eocd.writeUInt16LE(1, 10);
    eocd.writeUInt32LE(cdHeader.length, 12);
    eocd.writeUInt32LE(cdOffset, 16);

    return Buffer.concat([localHeader, compressed, cdHeader, eocd]);
}

function runSelfTest() {
    const assert = require('assert');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ib_cli_test_'));
    try {
        const docxPath = path.join(tmp, 'cv.docx');
        fs.writeFileSync(docxPath, buildMinimalDocxBuffer(['Tran Thi B - Frontend Developer', 'Kinh nghiem 2 nam React va TypeScript.']));
        const parsedDocx = extractDocumentText(docxPath);
        assert(parsedDocx.includes('Tran Thi B - Frontend Developer'), 'DOCX English line missing');
        assert(parsedDocx.includes('Kinh nghiem 2 nam React va TypeScript.'), 'DOCX second line missing');

        const jdPath = path.join(tmp, 'jd.md');
        fs.writeFileSync(jdPath, '# Frontend Engineer JD\nRequirements: React, TypeScript, English communication.', 'utf8');

        const tmpHome = path.join(tmp, 'home');
        fs.mkdirSync(path.join(tmpHome, '.claude'), { recursive: true });
        const installed = installSkill({ homeDir: tmpHome });
        assert.strictEqual(installed.length, 2, 'Expected .agents and .claude skill targets');
        assert(fs.existsSync(path.join(tmpHome, '.agents', 'skills', 'interview-bridge', 'SKILL.md')));
        assert(fs.existsSync(path.join(tmpHome, '.claude', 'skills', 'interview-bridge', 'SKILL.md')));

        const tmpCfg = path.join(tmp, 'cfg');
        const { prefs } = syncContext({
            cvPath: docxPath,
            jdPath,
            role: 'Frontend Engineer @ GlobalCo',
            salary: '$1400',
            notice: 'Immediate',
            reason: 'Want English product team',
            mode: 'hr_bilingual',
            configDir: tmpCfg,
        });
        const savedCfg = JSON.parse(fs.readFileSync(path.join(tmpCfg, 'config.json'), 'utf8'));
        const savedPrefs = JSON.parse(fs.readFileSync(path.join(tmpCfg, 'preferences.json'), 'utf8'));
        assert.strictEqual(savedCfg.configVersion, 1);
        assert(savedPrefs.customPrompt.includes('Frontend Engineer @ GlobalCo'));
        assert(savedPrefs.customPrompt.includes('Tran Thi B'));
        assert(savedPrefs.customPrompt.includes('Frontend Engineer JD'));
        assert.strictEqual(prefs.customPrompt, savedPrefs.customPrompt);

        console.log('CLI SELF-TEST PASSED');
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
}

function printHelp() {
    console.log(`
InterviewBridge AI CLI (v1.0.0)
Usage:
  npx github:${REPO_SLUG}                      Open interactive CLI menu
  npx github:${REPO_SLUG} skill                Install AI Agent Skill (~/.agents & ~/.claude)
  npx github:${REPO_SLUG} install-app          Download & run Windows .exe setup + LiveCaptionsTranslator
  npx github:${REPO_SLUG} context [options]    Load CV + JD + HR facts into Desktop App config
  npx github:${REPO_SLUG} status               Show installation, LiveCaptions, and CV/JD status

Context Options:
  --cv <file>       Path to CV (.pdf, .docx, .txt, .md)
  --jd <file>       Path to Job Description (.pdf, .docx, .txt, .md)
  --role <text>     Target role & company
  --salary <text>   Expected salary
  --notice <text>   Notice period / start date
  --reason <text>   Reason for leaving / joining
  --notes <text>    Extra instructions
  --mode <id>       hr_bilingual (default) | tech_bilingual | interview

Other Flags:
  --no-launch       Download installers without launching setup.exe
  --self-test       Run built-in verification suite
  --help, -h        Show this help message
`);
}

function parseFlags(args) {
    const out = {};
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (!a.startsWith('--')) continue;
        const key = a.slice(2);
        if (key === 'no-launch' || key === 'self-test' || key === 'help') {
            out[key] = true;
        } else if (i + 1 < args.length) {
            out[key] = args[++i];
        }
    }
    return out;
}

async function runInteractiveMenu() {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ask = q => new Promise(res => rl.question(q, ans => res(ans.trim())));

    try {
        while (true) {
            console.log(`
============================================================
  InterviewBridge AI — CLI & Agent Skill Manager (v1.0.0)
============================================================
  [1] Install AI Agent Skill (~/.agents/skills/interview-bridge)
  [2] Download & Install Windows App (.exe + LiveCaptions)
  [3] Load CV + JD & HR Quick Facts into App Config
  [4] Check System, Skill & Config Status
  [0] Exit
------------------------------------------------------------`);
            const choice = await ask('Select option [0-4]: ');
            if (choice === '0' || choice.toLowerCase() === 'q') {
                break;
            } else if (choice === '1') {
                const targets = installSkill();
                console.log('\n✓ Installed interview-bridge skill to:');
                targets.forEach(t => console.log(`  - ${t}`));
            } else if (choice === '2') {
                await installApp({ launch: true });
            } else if (choice === '3') {
                const cvPath = await ask('Path to CV (.pdf/.docx/.txt/.md, Enter to skip): ');
                const jdPath = await ask('Path to JD (.pdf/.docx/.txt/.md, Enter to skip): ');
                const role = await ask('Target Role & Company (e.g. Backend @ Acme): ');
                const salary = await ask('Expected Salary: ');
                const notice = await ask('Notice Period / Start Date: ');
                const reason = await ask('Reason for Leaving / Joining: ');
                const modeInput = await ask('Mode [1=hr_bilingual (default), 2=tech_bilingual]: ');
                const mode = modeInput === '2' ? 'tech_bilingual' : 'hr_bilingual';

                const { prefsPath, prefs } = syncContext({
                    cvPath: cvPath || undefined,
                    jdPath: jdPath || undefined,
                    role: role || undefined,
                    salary: salary || undefined,
                    notice: notice || undefined,
                    reason: reason || undefined,
                    mode,
                });
                console.log(`\n✓ Synced to ${prefsPath}`);
                console.log(`  Profile: ${prefs.selectedProfile} | CV: ${prefs.cvText.length} chars | JD: ${prefs.jdText.length} chars`);
            } else if (choice === '4') {
                printStatus(getStatus());
            } else {
                console.log('Invalid choice. Enter 0, 1, 2, 3, or 4.');
            }
        }
    } finally {
        rl.close();
    }
}

async function main() {
    const args = process.argv.slice(2);
    if (args.includes('--help') || args.includes('-h')) {
        printHelp();
        return;
    }
    if (args.includes('--self-test')) {
        runSelfTest();
        return;
    }

    const cmd = args[0];
    const flags = parseFlags(args.slice(1));

    if (!cmd) {
        await runInteractiveMenu();
        return;
    }

    if (cmd === 'skill') {
        const targets = installSkill();
        console.log('Installed interview-bridge skill to:');
        targets.forEach(t => console.log(`  - ${t}`));
        return;
    }

    if (cmd === 'install-app') {
        await installApp({ launch: !flags['no-launch'] });
        return;
    }

    if (cmd === 'context') {
        const { prefsPath, prefs } = syncContext({
            cvPath: flags.cv,
            jdPath: flags.jd,
            role: flags.role,
            salary: flags.salary,
            notice: flags.notice,
            reason: flags.reason,
            notes: flags.notes,
            mode: flags.mode,
            configDir: flags['config-dir'],
        });
        console.log(`Synced CV+JD context -> ${prefsPath}`);
        console.log(`Profile: ${prefs.selectedProfile} | CV: ${prefs.cvText.length} chars | JD: ${prefs.jdText.length} chars`);
        return;
    }

    if (cmd === 'status') {
        printStatus(getStatus({ configDir: flags['config-dir'] }));
        return;
    }

    console.error(`Unknown command: ${cmd}`);
    printHelp();
    process.exitCode = 1;
}

main().catch(err => {
    console.error(`Error: ${err.message}`);
    process.exit(1);
});
