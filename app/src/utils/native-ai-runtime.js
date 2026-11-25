const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { getConfigDir } = require('../storage');

const RELEASE_BASE_URL = 'https://github.com/sohzm/cheating-daddy/releases/download/v0.7.0';
const WIN_VULKAN_LLAMA_RELEASE = {
    tag: 'b12719',
    filename: 'llama-b12719-bin-win-vulkan-x64.zip',
    url: 'https://github.com/ggml-org/llama.cpp/releases/download/b12719/llama-b12719-bin-win-vulkan-x64.zip',
    sha256: '063ddd2a5daf02652ae5938068b56a8a5124a11a0a41f700bd7c09b624173e55',
    dirName: 'llama-vulkan-b12719',
};

const BINARY_RELEASES = {
    darwin: {
        arm64: {
            llama: {
                filename: 'llama-server-macos-arm64',
                sha256: 'edde3d15ee30a96abf09b99ce5ffe3ffd1c20dd484b380edd3c623c9b66ab6d5',
            },
            whisper: {
                filename: 'whisper-server-macos-arm64',
                sha256: '870093560fd80b4637dd900b880dc3566f17c809ae513ff653b265da13f41736',
            },
        },
        x64: {
            llama: {
                filename: 'llama-server-macos-x86_64',
                sha256: '728e4122b8ec9272d8b430cf0be44b6194ca3a21f531c1ae6f778e2174545a10',
            },
            whisper: {
                filename: 'whisper-server-macos-x86_64',
                sha256: '038099749adb67722133dba0daf41405dac57378b2e82d149b89e9fc39693ba9',
            },
        },
    },
    win32: {
        x64: {
            llama: {
                filename: 'llama-server-windows-x86_64.exe',
                sha256: '7dcdb6ae66c8a03f43d412f2fac00382b927a8d2d817d22b231c14a326cdc862',
            },
            whisper: {
                filename: 'whisper-server-windows-x86_64.exe',
                sha256: '654e4531ad7cebe772c08485a742be770d6848b0cda2f540b179f426a6105435',
            },
        },
    },
};

const WHISPER_MODELS = {
    'tiny.en': {
        filename: 'ggml-tiny.en.bin',
        url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin',
        sha256: '921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f',
    },
    'base.en': {
        filename: 'ggml-base.en.bin',
        url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin',
        sha256: 'a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002',
    },
    'small.en': {
        filename: 'ggml-small.en.bin',
        url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin',
        sha256: 'c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d',
    },
};

function getPlatformReleases() {
    const platformReleases = BINARY_RELEASES[process.platform]?.[process.arch];
    if (!platformReleases) {
        throw new Error(`Local AI is not available for ${process.platform}/${process.arch}`);
    }
    return platformReleases;
}

function getBinariesDirectory() {
    return path.join(getConfigDir(), 'binaries');
}

function getModelsDirectory() {
    return path.join(getConfigDir(), 'models');
}

async function calculateSha256(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const input = fs.createReadStream(filePath);
        input.on('error', reject);
        input.on('data', chunk => hash.update(chunk));
        input.on('end', () => resolve(hash.digest('hex')));
    });
}

async function fileMatchesChecksum(filePath, expectedSha256) {
    if (!fs.existsSync(filePath)) {
        return false;
    }

    const actualSha256 = await calculateSha256(filePath);
    return actualSha256 === expectedSha256;
}

async function downloadFile(url, destinationPath, onProgress, signal) {
    const temporaryPath = `${destinationPath}.download-${process.pid}-${Date.now()}`;
    const response = await fetch(url, { redirect: 'follow', signal });

    if (!response.ok || !response.body) {
        throw new Error(`Download failed with HTTP ${response.status}: ${url}`);
    }

    const expectedBytes = Number(response.headers.get('content-length')) || 0;
    let downloadedBytes = 0;

    try {
        const input = Readable.fromWeb(response.body);
        const progressStream = new Transform({
            transform(chunk, encoding, callback) {
                downloadedBytes += chunk.length;
                onProgress?.({ downloadedBytes, expectedBytes });
                callback(null, chunk);
            },
        });
        await pipeline(input, progressStream, fs.createWriteStream(temporaryPath, { flags: 'wx' }));

        return temporaryPath;
    } catch (error) {
        fs.rmSync(temporaryPath, { force: true });
        throw error;
    }
}

async function installVerifiedFile({ url, destinationPath, sha256, executable, onProgress, signal }) {
    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });

    if (await fileMatchesChecksum(destinationPath, sha256)) {
        if (executable && process.platform !== 'win32') {
            fs.chmodSync(destinationPath, 0o755);
        }
        return destinationPath;
    }

    const temporaryPath = await downloadFile(url, destinationPath, onProgress, signal);
    const downloadedSha256 = await calculateSha256(temporaryPath);

    if (downloadedSha256 !== sha256) {
        fs.rmSync(temporaryPath, { force: true });
        throw new Error(`Checksum verification failed for ${path.basename(destinationPath)}`);
    }

    fs.rmSync(destinationPath, { force: true });
    fs.renameSync(temporaryPath, destinationPath);

    if (executable && process.platform !== 'win32') {
        fs.chmodSync(destinationPath, 0o755);
    }

    return destinationPath;
}

function findFileRecursive(dirPath, targetFilename) {
    if (!fs.existsSync(dirPath)) return null;
    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isFile() && entry.name.toLowerCase() === targetFilename.toLowerCase()) {
            return fullPath;
        }
        if (entry.isDirectory()) {
            const nested = findFileRecursive(fullPath, targetFilename);
            if (nested) return nested;
        }
    }
    return null;
}

function extractArchive(zipPath, extractDir) {
    fs.mkdirSync(extractDir, { recursive: true });
    try {
        execFileSync('tar.exe', ['-xf', zipPath, '-C', extractDir], { windowsHide: true, stdio: 'pipe' });
        return;
    } catch {
        const escapedZip = zipPath.replace(/'/g, "''");
        const escapedDir = extractDir.replace(/'/g, "''");
        execFileSync(
            'powershell.exe',
            ['-NoProfile', '-Command', `Expand-Archive -Path '${escapedZip}' -DestinationPath '${escapedDir}' -Force`],
            { windowsHide: true, stdio: 'pipe' }
        );
    }
}

async function ensureWindowsVulkanLlama(onProgress, signal) {
    if (!fs.existsSync('C:\\Windows\\System32\\vulkan-1.dll')) {
        return null;
    }

    const extractDir = path.join(getBinariesDirectory(), WIN_VULKAN_LLAMA_RELEASE.dirName);
    const markerPath = path.join(extractDir, '.verified-sha256');
    const existingServer = findFileRecursive(extractDir, 'llama-server.exe');
    if (existingServer && fs.existsSync(markerPath) && fs.readFileSync(markerPath, 'utf8').trim() === WIN_VULKAN_LLAMA_RELEASE.sha256) {
        return existingServer;
    }

    const zipPath = path.join(getBinariesDirectory(), WIN_VULKAN_LLAMA_RELEASE.filename);
    await installVerifiedFile({
        url: WIN_VULKAN_LLAMA_RELEASE.url,
        destinationPath: zipPath,
        sha256: WIN_VULKAN_LLAMA_RELEASE.sha256,
        executable: false,
        onProgress,
        signal,
    });

    fs.rmSync(extractDir, { recursive: true, force: true });
    extractArchive(zipPath, extractDir);
    const extractedServer = findFileRecursive(extractDir, 'llama-server.exe');
    if (!extractedServer) {
        throw new Error('llama-server.exe not found inside extracted Vulkan archive');
    }

    fs.writeFileSync(markerPath, WIN_VULKAN_LLAMA_RELEASE.sha256, 'utf8');
    fs.rmSync(zipPath, { force: true });
    return extractedServer;
}

async function ensureNativeBinary(type, onProgress, signal) {
    if (process.platform === 'win32' && process.arch === 'x64' && type === 'llama') {
        try {
            const vulkanPath = await ensureWindowsVulkanLlama(onProgress, signal);
            if (vulkanPath) {
                console.log('[Runtime] Using Vulkan GPU llama-server:', vulkanPath);
                return vulkanPath;
            }
        } catch (error) {
            if (error.name === 'AbortError') throw error;
            console.warn('[Runtime] Vulkan llama setup failed, falling back to CPU binary:', error.message);
        }
    }

    const release = getPlatformReleases()[type];
    const destinationPath = path.join(getBinariesDirectory(), release.filename);

    return installVerifiedFile({
        url: `${RELEASE_BASE_URL}/${release.filename}`,
        destinationPath,
        sha256: release.sha256,
        executable: true,
        onProgress,
        signal,
    });
}

function normalizeWhisperModel(modelName) {
    const legacyModels = {
        'Xenova/whisper-tiny': 'tiny.en',
        'Xenova/whisper-base': 'base.en',
        'Xenova/whisper-small': 'small.en',
    };

    return legacyModels[modelName] || modelName || 'tiny.en';
}

async function ensureWhisperModel(modelName, onProgress, signal) {
    const normalizedModel = normalizeWhisperModel(modelName);
    const model = WHISPER_MODELS[normalizedModel];

    if (!model) {
        throw new Error(`Unsupported Whisper model: ${modelName}`);
    }

    const destinationPath = path.join(getModelsDirectory(), 'whisper', model.filename);
    return installVerifiedFile({
        url: model.url,
        destinationPath,
        sha256: model.sha256,
        executable: false,
        onProgress,
        signal,
    });
}

function encodePathParts(value) {
    return value
        .split('/')
        .map(part => encodeURIComponent(part))
        .join('/');
}

function parseHuggingFaceModelReference(modelReference) {
    const separatorIndex = modelReference.lastIndexOf(':');
    if (separatorIndex <= 0 || separatorIndex === modelReference.length - 1) {
        throw new Error('Language model must use the format owner/repository:quant');
    }

    const repository = modelReference.slice(0, separatorIndex);
    const quant = modelReference.slice(separatorIndex + 1);
    if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repository) || !/^[A-Za-z0-9._-]+$/.test(quant)) {
        throw new Error('Language model reference contains unsupported characters');
    }

    return {
        repository,
        quant,
    };
}

async function resolveHuggingFaceGguf(modelReference, signal, requireProjector = false) {
    const { repository, quant } = parseHuggingFaceModelReference(modelReference);
    const repositoryUrl = encodePathParts(repository);
    const response = await fetch(`https://huggingface.co/api/models/${repositoryUrl}/tree/main?recursive=true&expand=true`, { signal });

    if (!response.ok) {
        throw new Error(`Could not inspect Hugging Face model: HTTP ${response.status}`);
    }

    const files = await response.json();
    const normalizedQuant = quant.toUpperCase();
    const matches = files.filter(file => {
        return file.type === 'file' && file.path?.toLowerCase().endsWith('.gguf') && file.path.toUpperCase().includes(normalizedQuant);
    });

    if (matches.length !== 1) {
        throw new Error(`Expected one GGUF file for ${modelReference}, found ${matches.length}`);
    }

    const file = matches[0];
    if (!file.lfs?.oid || !file.size) {
        throw new Error(`Hugging Face did not provide checksum metadata for ${file.path}`);
    }

    const projector = files.find(candidate => candidate.type === 'file' && candidate.path === 'mmproj-BF16.gguf');
    if (requireProjector && (!projector?.lfs?.oid || !projector.size)) {
        throw new Error(`Hugging Face model ${repository} does not provide mmproj-BF16.gguf`);
    }

    return {
        repository,
        model: {
            path: file.path,
            sha256: file.lfs.oid,
        },
        projector: projector?.lfs?.oid
            ? {
                  path: projector.path,
                  sha256: projector.lfs.oid,
              }
            : null,
    };
}

async function ensureLlamaModel(modelReference, onModelProgress, onProjectorProgress, signal, options = {}) {
    const { requireProjector = false } = options;

    if (path.isAbsolute(modelReference)) {
        if (!fs.existsSync(modelReference)) {
            throw new Error(`Language model does not exist: ${modelReference}`);
        }

        const projectorPath = path.join(path.dirname(modelReference), 'mmproj-BF16.gguf');
        const projectorExists = fs.existsSync(projectorPath);
        if (requireProjector && !projectorExists) {
            throw new Error(`Multimodal projector does not exist: ${projectorPath}`);
        }

        return {
            modelPath: modelReference,
            projectorPath: projectorExists ? projectorPath : null,
        };
    }

    const model = await resolveHuggingFaceGguf(modelReference, signal, requireProjector);
    const repositoryDirectory = path.join(getModelsDirectory(), 'llama', model.repository);
    const modelPath = await installVerifiedFile({
        url: `https://huggingface.co/${encodePathParts(model.repository)}/resolve/main/${encodePathParts(model.model.path)}`,
        destinationPath: path.join(repositoryDirectory, path.basename(model.model.path)),
        sha256: model.model.sha256,
        executable: false,
        onProgress: onModelProgress,
        signal,
    });

    let projectorPath = null;
    if (model.projector) {
        const localProjectorPath = path.join(repositoryDirectory, path.basename(model.projector.path));
        if (requireProjector) {
            projectorPath = await installVerifiedFile({
                url: `https://huggingface.co/${encodePathParts(model.repository)}/resolve/main/${encodePathParts(model.projector.path)}`,
                destinationPath: localProjectorPath,
                sha256: model.projector.sha256,
                executable: false,
                onProgress: onProjectorProgress,
                signal,
            });
        } else if (fs.existsSync(localProjectorPath)) {
            projectorPath = localProjectorPath;
        }
    }

    return {
        modelPath,
        projectorPath,
    };
}

async function getAvailablePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.unref();
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            server.close(() => resolve(address.port));
        });
    });
}

function attachProcessLogging(childProcess, name) {
    childProcess.stdout.on('data', data => {
        process.stdout.write(`[${name}] ${data}`);
    });
    childProcess.stderr.on('data', data => {
        process.stderr.write(`[${name}] ${data}`);
    });
}

function startNativeServer({ executablePath, arguments: serverArguments, name, environment = {} }) {
    const childProcess = spawn(executablePath, serverArguments, {
        env: { ...process.env, ...environment },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
    });

    attachProcessLogging(childProcess, name);
    return childProcess;
}

async function waitForServer(url, childProcess, timeoutMs) {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
        if (childProcess.exitCode !== null) {
            throw new Error(`Native server exited with code ${childProcess.exitCode}`);
        }

        try {
            const response = await fetch(url);
            if (response.ok) {
                return;
            }
        } catch {
            // The server is still starting.
        }

        await new Promise(resolve => setTimeout(resolve, 250));
    }

    throw new Error(`Native server did not become ready: ${url}`);
}

function stopNativeServer(childProcess) {
    if (!childProcess || childProcess.exitCode !== null) {
        return;
    }

    childProcess.kill();
}

module.exports = {
    ensureNativeBinary,
    ensureLlamaModel,
    ensureWhisperModel,
    getAvailablePort,
    getModelsDirectory,
    startNativeServer,
    stopNativeServer,
    waitForServer,
};
