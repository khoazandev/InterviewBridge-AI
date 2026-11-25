const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { app } = require('electron');
const { getSystemPrompt } = require('./prompts');
const { sendToRenderer, initializeNewSession, saveConversationTurn } = require('./gemini');
const {
    ensureNativeBinary,
    ensureLlamaModel,
    ensureWhisperModel,
    getAvailablePort,
    getModelsDirectory,
    startNativeServer,
    stopNativeServer,
    waitForServer,
} = require('./native-ai-runtime');

let llamaProcess = null;
let llamaBaseUrl = null;
let llamaModel = null;
let currentLlamaExecutablePath = null;
let currentLlamaModelPath = null;
let currentProjectorPath = null;
let llamaLoadedWithProjector = false;
let whisperProcess = null;
let whisperBaseUrl = null;
let localConversationHistory = [];
let currentSystemPrompt = null;
let currentProfile = 'hr_bilingual';
let isLocalActive = false;
let initializationController = null;
let llamaCacheSnapshot = new Set();

let isSpeaking = false;
let speechBuffers = [];
let preRollBuffers = [];
let speechBytesAccumulated = 0;
let silenceFrameCount = 0;
let speechFrameCount = 0;
let pendingUtterances = [];
let isGeneratingLlama = false;
let activeQueuePromise = null;

const VAD_MODES = {
    NORMAL: { energyThreshold: 0.007, speechFramesRequired: 2, silenceFramesRequired: 6, softFlushBytes: 176000, hardFlushBytes: 288000 },
    LOW_BITRATE: { energyThreshold: 0.006, speechFramesRequired: 3, silenceFramesRequired: 10, softFlushBytes: 176000, hardFlushBytes: 288000 },
    AGGRESSIVE: { energyThreshold: 0.01, speechFramesRequired: 2, silenceFramesRequired: 6, softFlushBytes: 176000, hardFlushBytes: 288000 },
    VERY_AGGRESSIVE: { energyThreshold: 0.007, speechFramesRequired: 2, silenceFramesRequired: 6, softFlushBytes: 176000, hardFlushBytes: 288000 },
};

let vadConfig = VAD_MODES.NORMAL;
let resampleRemainder = Buffer.alloc(0);

function parseOllamaModel(modelRef) {
    if (typeof modelRef === 'string' && modelRef.trim().toLowerCase().startsWith('ollama:')) {
        return modelRef.trim().slice(7).trim();
    }
    return null;
}

function resample24kTo16k(inputBuffer) {
    const combined = Buffer.concat([resampleRemainder, inputBuffer]);
    const inputSamples = Math.floor(combined.length / 2);
    const outputSamples = Math.floor((inputSamples * 2) / 3);
    const outputBuffer = Buffer.alloc(outputSamples * 2);

    for (let i = 0; i < outputSamples; i++) {
        const sourcePosition = (i * 3) / 2;
        const sourceIndex = Math.floor(sourcePosition);
        const fraction = sourcePosition - sourceIndex;
        const firstSample = combined.readInt16LE(sourceIndex * 2);
        const secondSample = sourceIndex + 1 < inputSamples ? combined.readInt16LE((sourceIndex + 1) * 2) : firstSample;
        const interpolated = Math.round(firstSample + fraction * (secondSample - firstSample));
        outputBuffer.writeInt16LE(Math.max(-32768, Math.min(32767, interpolated)), i * 2);
    }

    const consumedInputSamples = Math.ceil((outputSamples * 3) / 2);
    const remainderStart = consumedInputSamples * 2;
    resampleRemainder = remainderStart < combined.length ? combined.slice(remainderStart) : Buffer.alloc(0);

    return outputBuffer;
}

function calculateRms(pcm16Buffer) {
    const samples = pcm16Buffer.length / 2;
    if (samples === 0) return 0;

    let sumSquares = 0;
    for (let i = 0; i < samples; i++) {
        const sample = pcm16Buffer.readInt16LE(i * 2) / 32768;
        sumSquares += sample * sample;
    }

    return Math.sqrt(sumSquares / samples);
}

function stripThinkingTags(text) {
    return String(text || '')
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/<think>[\s\S]*$/i, '')
        .trim();
}

function flushSpeechSegment(keepSpeaking = false) {
    const audioData = Buffer.concat(speechBuffers);
    speechBuffers = [];
    speechBytesAccumulated = 0;
    silenceFrameCount = 0;
    isSpeaking = keepSpeaking;
    if (!keepSpeaking) {
        speechFrameCount = 0;
    }
    console.log('[LocalAI] Flushing speech segment:', audioData.length, 'bytes, keepSpeaking:', keepSpeaking);
    sendToRenderer('update-status', 'Transcribing...');
    handleSpeechEnd(audioData);
}

function processVad(pcm16kBuffer) {
    const rms = calculateRms(pcm16kBuffer);
    const isVoice = rms > vadConfig.energyThreshold;
    const chunkCopy = Buffer.from(pcm16kBuffer);

    if (!isSpeaking) {
        preRollBuffers.push(chunkCopy);
        if (preRollBuffers.length > 3) {
            preRollBuffers.shift();
        }
    }

    if (isVoice) {
        speechFrameCount += 1;
        silenceFrameCount = 0;

        if (!isSpeaking && speechFrameCount >= vadConfig.speechFramesRequired) {
            isSpeaking = true;
            speechBuffers = [...preRollBuffers];
            preRollBuffers = [];
            speechBytesAccumulated = speechBuffers.reduce((sum, buf) => sum + buf.length, 0);
            console.log('[LocalAI] Speech started (RMS:', rms.toFixed(4), ')');
            sendToRenderer('update-status', 'Listening... (speech detected)');
        }
    } else {
        silenceFrameCount += 1;
        speechFrameCount = 0;

        if (
            isSpeaking &&
            (silenceFrameCount >= vadConfig.silenceFramesRequired ||
                (silenceFrameCount >= 2 && speechBytesAccumulated >= vadConfig.softFlushBytes))
        ) {
            flushSpeechSegment(false);
            return;
        }
    }

    if (isSpeaking) {
        speechBuffers.push(chunkCopy);
        speechBytesAccumulated += chunkCopy.length;
        if (speechBytesAccumulated >= vadConfig.hardFlushBytes) {
            flushSpeechSegment(true);
        }
    }
}

function createWavBuffer(pcm16Buffer) {
    const header = Buffer.alloc(44);
    const byteRate = 16000 * 2;

    header.write('RIFF', 0);
    header.writeUInt32LE(36 + pcm16Buffer.length, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(16000, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36);
    header.writeUInt32LE(pcm16Buffer.length, 40);

    return Buffer.concat([header, pcm16Buffer]);
}

async function transcribeAudio(pcm16kBuffer) {
    if (!whisperBaseUrl) {
        throw new Error('Whisper server is not running');
    }

    const wavBuffer = createWavBuffer(pcm16kBuffer);
    const formData = new FormData();
    formData.append('file', new Blob([wavBuffer], { type: 'audio/wav' }), 'speech.wav');
    formData.append('response_format', 'json');
    formData.append('temperature', '0.0');
    formData.append('language', 'en');

    const response = await fetch(`${whisperBaseUrl}/inference`, {
        method: 'POST',
        body: formData,
    });

    if (!response.ok) {
        throw new Error(`Whisper server returned HTTP ${response.status}`);
    }

    const result = await response.json();
    const text = result.text?.trim() || '';
    const viText = result.vi_text?.trim() || '';
    console.log('[LocalAI] Transcription:', text);
    return { text, viText };
}

async function handleSpeechEnd(audioData) {
    if (!isLocalActive) return;

    if (audioData.length < 9600) {
        console.log('[LocalAI] Audio too short, skipping');
        if (!isGeneratingLlama) {
            sendToRenderer('update-status', 'Listening...');
        }
        return;
    }

    try {
        const { text: transcription, viText } = await transcribeAudio(audioData);
        if (!isLocalActive) return;

        if (!transcription || transcription.length < 2) {
            console.log('[LocalAI] Empty transcription, skipping');
            if (!isGeneratingLlama) {
                sendToRenderer('update-status', 'Listening...');
            }
            return;
        }

        sendToRenderer('live-transcript', { en: transcription, vi: viText });
        enqueueLlamaTurn(transcription, viText);
    } catch (error) {
        console.error('[LocalAI] Transcription error:', error);
        sendToRenderer('update-status', 'Transcription error: ' + error.message);
    }
}

async function readStreamingResponse(response, onText) {
    const decoder = new TextDecoder();
    let pendingText = '';
    let fullText = '';

    for await (const chunk of response.body) {
        pendingText += decoder.decode(chunk, { stream: true });
        const lines = pendingText.split('\n');
        pendingText = lines.pop() || '';

        for (const line of lines) {
            if (!line.startsWith('data: ')) continue;

            const data = line.slice(6).trim();
            if (!data || data === '[DONE]') continue;

            const event = JSON.parse(data);
            const token = event.choices?.[0]?.delta?.content || '';
            if (!token) continue;

            fullText += token;
            const cleanText = stripThinkingTags(fullText);
            if (cleanText) {
                onText?.(cleanText);
            }
        }
    }

    return stripThinkingTags(fullText);
}

async function requestLlama(messages, onText, options = {}) {
    if (!llamaBaseUrl) {
        throw new Error('Llama server is not running');
    }

    const ollamaTag = parseOllamaModel(llamaModel);
    const payload = {
        model: ollamaTag || 'local',
        messages,
        stream: true,
        temperature: 0.2,
        max_tokens: options.maxTokens || 320,
    };
    if (!ollamaTag) {
        payload.cache_prompt = true;
        payload.chat_template_kwargs = { enable_thinking: false };
    }

    const response = await fetch(`${llamaBaseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: options.signal,
    });

    if (!response.ok || !response.body) {
        const errorText = await response.text();
        throw new Error(`Llama server returned HTTP ${response.status}: ${errorText}`);
    }

    return readStreamingResponse(response, onText);
}

function enqueueLlamaTurn(enText, viHint = '') {
    const cleanEn = String(enText || '').trim();
    if (!cleanEn) {
        return Promise.resolve();
    }

    pendingUtterances.push({ en: cleanEn, vi: String(viHint || '').trim() });
    if (!activeQueuePromise) {
        activeQueuePromise = drainLlamaQueue().finally(() => {
            activeQueuePromise = null;
        });
    }
    return activeQueuePromise;
}

async function drainLlamaQueue() {
    isGeneratingLlama = true;
    try {
        while (isLocalActive && pendingUtterances.length > 0) {
            const batch = pendingUtterances.splice(0, pendingUtterances.length);
            const combinedEn = batch.map(item => item.en).filter(Boolean).join(' ');
            const combinedVi = batch.map(item => item.vi).filter(Boolean).join(' ');
            if (!combinedEn) continue;

            sendToRenderer('update-status', 'Generating response...');
            try {
                await sendToLlama(combinedEn, combinedVi);
            } catch (error) {
                console.error('[LocalAI] Queued turn error:', error);
            }
        }
    } finally {
        isGeneratingLlama = false;
    }
}

async function sendToLlama(transcription, viHint = '') {
    const cleanEn = transcription.trim();
    const cleanVi = String(viHint || '').trim();
    const promptUserContent = cleanVi ? `Interviewer (EN): ${cleanEn}\n(Vietnamese meaning: ${cleanVi})` : cleanEn;

    try {
        const priorHistory = localConversationHistory.slice(-6);
        const messages = [
            { role: 'system', content: currentSystemPrompt || 'You are a helpful assistant.' },
            ...priorHistory,
            { role: 'user', content: promptUserContent },
        ];

        let isFirst = true;
        const fullText = await requestLlama(messages, text => {
            sendToRenderer(isFirst ? 'new-response' : 'update-response', text);
            isFirst = false;
        });

        if (fullText.trim()) {
            localConversationHistory.push({ role: 'user', content: cleanEn });
            localConversationHistory.push({ role: 'assistant', content: fullText.trim() });
            if (localConversationHistory.length > 8) {
                localConversationHistory = localConversationHistory.slice(-8);
            }
            saveConversationTurn(cleanEn, fullText);
        }

        console.log('[LocalAI] Llama response completed');
        if (pendingUtterances.length === 0) {
            sendToRenderer('update-status', 'Listening...');
        }
    } catch (error) {
        console.error('[LocalAI] Llama error:', error);
        sendToRenderer('update-status', 'Local AI error: ' + error.message);
        throw error;
    }
}

function formatDownloadStatus(label, progress) {
    if (!progress.expectedBytes) {
        return `Downloading ${label}...`;
    }

    const percentage = Math.floor((progress.downloadedBytes / progress.expectedBytes) * 100);
    return `Downloading ${label}... ${percentage}%`;
}

function sendDownloadProgress(label, progress = null) {
    const percentage = progress?.expectedBytes ? Math.min(100, Math.floor((progress.downloadedBytes / progress.expectedBytes) * 100)) : null;
    sendToRenderer('local-ai-download-progress', {
        active: true,
        label,
        percentage,
    });
}

function getDirectoryEntries(directoryPath) {
    if (!fs.existsSync(directoryPath)) {
        return new Set();
    }

    const entries = new Set();
    const visit = currentPath => {
        for (const entry of fs.readdirSync(currentPath, { withFileTypes: true })) {
            const entryPath = path.join(currentPath, entry.name);
            entries.add(entryPath);
            if (entry.isDirectory()) {
                visit(entryPath);
            }
        }
    };

    visit(directoryPath);
    return entries;
}

function removeNewLlamaCacheEntries() {
    const cacheDirectory = path.join(getModelsDirectory(), 'llama');
    const currentEntries = Array.from(getDirectoryEntries(cacheDirectory));
    currentEntries.sort((first, second) => second.length - first.length);

    for (const entryPath of currentEntries) {
        if (!llamaCacheSnapshot.has(entryPath)) {
            fs.rmSync(entryPath, { recursive: true, force: true });
        }
    }
}

async function prepareNativeFiles(llamaModelReference, whisperModel, signal) {
    const binaryProgress = label => progress => {
        sendToRenderer('update-status', formatDownloadStatus(label, progress));
        sendDownloadProgress(label, progress);
    };

    sendDownloadProgress('Checking Llama runner');
    const llamaBinaryPath = await ensureNativeBinary('llama', binaryProgress('Llama runner'), signal);

    sendDownloadProgress('Checking Whisper runner');
    const whisperBinaryPath = await ensureNativeBinary('whisper', binaryProgress('Whisper runner'), signal);

    let whisperModelPath;
    sendToRenderer('whisper-downloading', true);
    try {
        sendDownloadProgress('Checking Whisper model');
        whisperModelPath = await ensureWhisperModel(whisperModel, binaryProgress('Whisper model'), signal);
    } finally {
        sendToRenderer('whisper-downloading', false);
    }

    sendDownloadProgress('Checking language model');
    const llamaFiles = await ensureLlamaModel(llamaModelReference, binaryProgress('Language model'), binaryProgress('Vision model'), signal);
    return {
        llamaBinaryPath,
        whisperBinaryPath,
        whisperModelPath,
        llamaModelPath: llamaFiles.modelPath,
        projectorPath: llamaFiles.projectorPath,
    };
}

function validatePreparedNativeFiles(nativeFiles) {
    const requiredFiles = [
        ['Llama runner', nativeFiles.llamaBinaryPath],
        ['Whisper runner', nativeFiles.whisperBinaryPath],
        ['Whisper model', nativeFiles.whisperModelPath],
        ['Language model', nativeFiles.llamaModelPath],
    ];

    for (const [label, filePath] of requiredFiles) {
        if (!filePath || !fs.existsSync(filePath)) {
            throw new Error(`${label} path is invalid: ${filePath}`);
        }
    }
}

async function startWhisperServer(executablePath, modelPath) {
    const port = await getAvailablePort();
    whisperBaseUrl = `http://127.0.0.1:${port}`;
    whisperProcess = startNativeServer({
        executablePath,
        arguments: ['-m', modelPath, '--host', '127.0.0.1', '--port', String(port)],
        name: 'Whisper',
    });

    await waitForServer(`${whisperBaseUrl}/`, whisperProcess, 120000);
}

async function startLlamaServer(executablePath, modelPath, projectorPath = null, useGpu = true) {
    if (!modelPath || !fs.existsSync(modelPath)) {
        throw new Error(`Language model path is invalid: ${modelPath}`);
    }

    const useProjector = Boolean(projectorPath && fs.existsSync(projectorPath));
    const port = await getAvailablePort();
    const argumentsList = [
        '--host',
        '127.0.0.1',
        '--port',
        String(port),
        '--alias',
        'local',
        '-c',
        '4096',
        '--cache-reuse',
        '256',
        '-m',
        modelPath,
    ];

    if (useProjector) {
        argumentsList.push('--mmproj', projectorPath);
    }

    if (useGpu && (process.platform === 'darwin' || process.platform === 'win32')) {
        argumentsList.push('-ngl', '99');
    }

    llamaBaseUrl = `http://127.0.0.1:${port}`;
    llamaProcess = startNativeServer({
        executablePath,
        arguments: argumentsList,
        name: 'Llama',
    });

    try {
        await waitForServer(`${llamaBaseUrl}/health`, llamaProcess, 30 * 60 * 1000);
        currentLlamaExecutablePath = executablePath;
        currentLlamaModelPath = modelPath;
        currentProjectorPath = useProjector ? projectorPath : null;
        llamaLoadedWithProjector = useProjector;
    } catch (error) {
        stopNativeServer(llamaProcess);
        llamaProcess = null;
        if (useGpu && process.platform === 'win32') {
            console.warn('[LocalAI] GPU llama-server startup failed, retrying without -ngl:', error.message);
            return startLlamaServer(executablePath, modelPath, projectorPath, false);
        }
        throw error;
    }
}

async function warmupLlamaPrompt() {
    if (!llamaBaseUrl || parseOllamaModel(llamaModel)) {
        return;
    }
    try {
        await requestLlama(
            [
                { role: 'system', content: currentSystemPrompt || 'You are a helpful assistant.' },
                { role: 'user', content: 'Hi' },
            ],
            null,
            { maxTokens: 1, signal: AbortSignal.timeout(45000) }
        );
        console.log('[LocalAI] System prompt KV cache warmed up');
    } catch (error) {
        console.warn('[LocalAI] Prompt warmup skipped:', error.message);
    }
}

async function ensureCt2WhisperServer(signal) {
    const defaultUrl = 'http://127.0.0.1:8989';
    try {
        const ping = await fetch(`${defaultUrl}/health`, { signal: AbortSignal.timeout(1200) });
        if (ping.ok) {
            whisperBaseUrl = defaultUrl;
            whisperProcess = null;
            console.log('[LocalAI] Connected to running CTranslate2 engine at', defaultUrl);
            return true;
        }
    } catch {
        // Not running yet; try auto-starting scripts/ct2_engine.py
    }

    const ct2ScriptPath = app?.isPackaged
        ? path.join(process.resourcesPath, 'ct2_engine.py')
        : path.resolve(__dirname, '../../scripts/ct2_engine.py');
    if (!fs.existsSync(ct2ScriptPath)) {
        return false;
    }

    const port = await getAvailablePort();
    for (const pyCmd of ['python', 'py']) {
        try {
            const proc = spawn(pyCmd, [ct2ScriptPath, '--port', String(port)], {
                env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
                stdio: ['ignore', 'pipe', 'pipe'],
                windowsHide: true,
            });
            proc.stdout.on('data', d => process.stdout.write(`[CT2] ${d}`));
            proc.stderr.on('data', d => process.stderr.write(`[CT2] ${d}`));
            const candidateUrl = `http://127.0.0.1:${port}`;
            await waitForServer(`${candidateUrl}/health`, proc, 180000);
            if (signal?.aborted) {
                stopNativeServer(proc);
                throw new DOMException('Aborted', 'AbortError');
            }
            whisperProcess = proc;
            whisperBaseUrl = candidateUrl;
            console.log('[LocalAI] Started CTranslate2 engine at', candidateUrl);
            return true;
        } catch (err) {
            if (err.name === 'AbortError') throw err;
            console.warn(`[LocalAI] CT2 engine via '${pyCmd}' unavailable (${err.message}), falling back if needed.`);
        }
    }
    return false;
}

async function initializeLocalSession(model, whisperModel, profile, customPrompt) {
    console.log('[LocalAI] Initializing native local session:', { model, whisperModel, profile });
    sendToRenderer('session-initializing', true);

    try {
        closeLocalSession();
        initializationController = new AbortController();
        llamaCacheSnapshot = getDirectoryEntries(path.join(getModelsDirectory(), 'llama'));
        currentProfile = profile || 'hr_bilingual';
        currentSystemPrompt = getSystemPrompt(profile, customPrompt, false);
        llamaModel = model;

        sendToRenderer('update-status', 'Starting speech & translation engine...');
        sendDownloadProgress('Checking CTranslate2 engine');
        const ct2Ready = await ensureCt2WhisperServer(initializationController.signal);

        const ollamaTag = parseOllamaModel(model);
        if (ollamaTag) {
            const ollamaHost = (process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/$/, '');
            try {
                const ping = await fetch(`${ollamaHost}/api/tags`, { signal: initializationController.signal });
                if (!ping.ok) throw new Error(`HTTP ${ping.status}`);
            } catch (err) {
                if (err.name === 'AbortError') throw err;
                throw new Error(
                    'Ollama is not running on 127.0.0.1:11434. Start Ollama first, or select a built-in Qwen 3.5 GGUF model (no Ollama needed).'
                );
            }

            if (!ct2Ready) {
                const progressCb = label => progress => {
                    sendToRenderer('update-status', formatDownloadStatus(label, progress));
                    sendDownloadProgress(label, progress);
                };
                sendDownloadProgress('Checking Whisper runner');
                const whisperBinaryPath = await ensureNativeBinary('whisper', progressCb('Whisper runner'), initializationController.signal);

                let whisperModelPath;
                sendToRenderer('whisper-downloading', true);
                try {
                    sendDownloadProgress('Checking Whisper model');
                    whisperModelPath = await ensureWhisperModel(whisperModel, progressCb('Whisper model'), initializationController.signal);
                } finally {
                    sendToRenderer('whisper-downloading', false);
                }

                sendToRenderer('update-status', 'Starting Whisper...');
                sendDownloadProgress('Starting Whisper');
                await startWhisperServer(whisperBinaryPath, whisperModelPath);
            }
            llamaBaseUrl = ollamaHost;
        } else if (ct2Ready) {
            const progressCb = label => progress => {
                sendToRenderer('update-status', formatDownloadStatus(label, progress));
                sendDownloadProgress(label, progress);
            };
            sendDownloadProgress('Checking Llama runner');
            const llamaBinaryPath = await ensureNativeBinary('llama', progressCb('Llama runner'), initializationController.signal);
            sendDownloadProgress('Checking language model');
            const llamaFiles = await ensureLlamaModel(
                model,
                progressCb('Language model'),
                progressCb('Vision model'),
                initializationController.signal
            );
            sendToRenderer('update-status', 'Loading local language model...');
            sendDownloadProgress('Loading language model');
            await startLlamaServer(llamaBinaryPath, llamaFiles.modelPath, null);
            sendToRenderer('update-status', 'Warming up CV & JD prompt cache...');
            await warmupLlamaPrompt();
        } else {
            const nativeFiles = await prepareNativeFiles(model, whisperModel, initializationController.signal);
            validatePreparedNativeFiles(nativeFiles);

            sendToRenderer('update-status', 'Starting Whisper...');
            sendDownloadProgress('Starting Whisper');
            await startWhisperServer(nativeFiles.whisperBinaryPath, nativeFiles.whisperModelPath);

            sendToRenderer('update-status', 'Loading local language model...');
            sendDownloadProgress('Loading language model');
            await startLlamaServer(nativeFiles.llamaBinaryPath, nativeFiles.llamaModelPath, null);
            sendToRenderer('update-status', 'Warming up CV & JD prompt cache...');
            await warmupLlamaPrompt();
        }

        isSpeaking = false;
        speechBuffers = [];
        preRollBuffers = [];
        speechBytesAccumulated = 0;
        silenceFrameCount = 0;
        speechFrameCount = 0;
        pendingUtterances = [];
        isGeneratingLlama = false;
        activeQueuePromise = null;
        resampleRemainder = Buffer.alloc(0);
        localConversationHistory = [];

        initializeNewSession(profile, customPrompt);
        isLocalActive = true;
        initializationController = null;
        sendToRenderer('local-ai-download-progress', { active: false });
        sendToRenderer('session-initializing', false);
        sendToRenderer('update-status', 'Local AI ready - Listening...');
        console.log('[LocalAI] Native session initialized successfully');
        return true;
    } catch (error) {
        const wasCancelled = error.name === 'AbortError' || initializationController?.signal.aborted;
        if (wasCancelled) {
            console.log('[LocalAI] Initialization cancelled');
        } else {
            console.error('[LocalAI] Initialization error:', error);
        }
        closeLocalSession();
        if (wasCancelled) {
            removeNewLlamaCacheEntries();
        }
        sendToRenderer('local-ai-download-progress', { active: false });
        sendToRenderer('session-initializing', false);
        sendToRenderer('update-status', wasCancelled ? 'Local AI download cancelled' : 'Local AI error: ' + error.message);
        return false;
    }
}

function processLocalAudio(monoChunk24k) {
    if (!isLocalActive) return;

    const pcm16k = resample24kTo16k(monoChunk24k);
    if (pcm16k.length > 0) {
        processVad(pcm16k);
    }
}

function closeLocalSession() {
    isLocalActive = false;
    initializationController?.abort();
    initializationController = null;
    stopNativeServer(llamaProcess);
    stopNativeServer(whisperProcess);
    llamaProcess = null;
    whisperProcess = null;
    llamaBaseUrl = null;
    whisperBaseUrl = null;
    llamaModel = null;
    currentLlamaExecutablePath = null;
    currentLlamaModelPath = null;
    currentProjectorPath = null;
    llamaLoadedWithProjector = false;
    isSpeaking = false;
    speechBuffers = [];
    preRollBuffers = [];
    speechBytesAccumulated = 0;
    silenceFrameCount = 0;
    speechFrameCount = 0;
    pendingUtterances = [];
    isGeneratingLlama = false;
    activeQueuePromise = null;
    resampleRemainder = Buffer.alloc(0);
    localConversationHistory = [];
    currentSystemPrompt = null;
}

async function cancelLocalInitialization() {
    if (!initializationController) {
        return false;
    }

    initializationController.abort();
    stopNativeServer(llamaProcess);
    stopNativeServer(whisperProcess);
    await new Promise(resolve => setTimeout(resolve, 300));
    removeNewLlamaCacheEntries();
    sendToRenderer('local-ai-download-progress', { active: false });
    sendToRenderer('session-initializing', false);
    return true;
}

function isLocalSessionActive() {
    return isLocalActive;
}

async function sendLocalText(text) {
    if (!isLocalActive || !llamaBaseUrl) {
        return { success: false, error: 'No active local session' };
    }

    try {
        const clean = text.trim();
        sendToRenderer('live-transcript', { en: clean });
        fetch('http://127.0.0.1:8989/translate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: clean, from: 'en', to: 'vi' }),
            signal: AbortSignal.timeout(1500),
        })
            .then(r => (r.ok ? r.json() : null))
            .then(d => {
                if (d?.result) sendToRenderer('live-transcript', { en: clean, vi: d.result });
            })
            .catch(() => {});
        await enqueueLlamaTurn(clean, '');
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

async function sendLocalImage(base64Data, prompt) {
    if (!isLocalActive || !llamaBaseUrl) {
        return { success: false, error: 'No active local session' };
    }

    if (!llamaLoadedWithProjector && !parseOllamaModel(llamaModel) && currentLlamaExecutablePath && currentLlamaModelPath) {
        sendToRenderer('update-status', 'Loading vision projector...');
        const ensured = await ensureLlamaModel(llamaModel, null, null, undefined, { requireProjector: true });
        if (ensured.projectorPath) {
            stopNativeServer(llamaProcess);
            llamaProcess = null;
            await startLlamaServer(currentLlamaExecutablePath, currentLlamaModelPath, ensured.projectorPath);
            await warmupLlamaPrompt();
        }
    }

    const userMessage = {
        role: 'user',
        content: [
            { type: 'text', text: prompt },
            {
                type: 'image_url',
                image_url: {
                    url: `data:image/jpeg;base64,${base64Data}`,
                },
            },
        ],
    };

    try {
        sendToRenderer('update-status', 'Analyzing image...');
        const messages = [
            { role: 'system', content: currentSystemPrompt || 'You are a helpful assistant.' },
            ...localConversationHistory.slice(-6),
            userMessage,
        ];

        let isFirst = true;
        const fullText = await requestLlama(messages, text => {
            sendToRenderer(isFirst ? 'new-response' : 'update-response', text);
            isFirst = false;
        });

        if (fullText.trim()) {
            localConversationHistory.push({ role: 'user', content: prompt });
            localConversationHistory.push({ role: 'assistant', content: fullText.trim() });
            if (localConversationHistory.length > 8) {
                localConversationHistory = localConversationHistory.slice(-8);
            }
            saveConversationTurn(prompt, fullText);
        }

        sendToRenderer('update-status', 'Listening...');
        return { success: true, text: fullText, model: llamaModel };
    } catch (error) {
        console.error('[LocalAI] Image error:', error);
        sendToRenderer('update-status', 'Local AI image error: ' + error.message);
        return { success: false, error: error.message };
    }
}

module.exports = {
    initializeLocalSession,
    cancelLocalInitialization,
    processLocalAudio,
    closeLocalSession,
    isLocalSessionActive,
    sendLocalText,
    sendLocalImage,
};
