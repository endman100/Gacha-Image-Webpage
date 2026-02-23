const HF_HUB_PROMISE_KEY = '__hfHubModulePromise';

const TARGET_FOLDER_MAX_CONCURRENT_DOWNLOADS = 5;
const targetFolderDownloadQueue = [];
const targetFolderDownloadPromiseByKey = new Map();
let targetFolderDownloadActiveCount = 0;
const targetFolderLoadGeneration = {};
const targetFolderLazyObserverByLora = {};

function getTargetFolderDownloadKey(loraName, path) {
    return `${String(loraName || '')}::${String(path || '')}`;
}

function waitForImageReady(src, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
        const safeSrc = String(src || '').trim();
        if (!safeSrc) {
            reject(new Error('Missing image src'));
            return;
        }

        const img = new Image();
        let done = false;
        const timeoutId = setTimeout(() => {
            if (done) {
                return;
            }
            done = true;
            reject(new Error('Image load timeout'));
        }, timeoutMs);

        function cleanup() {
            clearTimeout(timeoutId);
            img.onload = null;
            img.onerror = null;
        }

        img.onload = () => {
            if (done) {
                return;
            }

            const finalize = () => {
                if (done) {
                    return;
                }
                done = true;
                cleanup();
                resolve();
            };

            if (typeof img.decode === 'function') {
                img.decode().then(finalize).catch(finalize);
                return;
            }

            finalize();
        };

        img.onerror = () => {
            if (done) {
                return;
            }
            done = true;
            cleanup();
            reject(new Error('Image failed to load'));
        };

        img.src = safeSrc;
    });
}

function disconnectTargetFolderLazyObserver(loraName) {
    const safeLora = String(loraName || '').trim();
    const observer = targetFolderLazyObserverByLora[safeLora];
    if (observer) {
        try {
            observer.disconnect();
        } catch (_) {
        }
    }
    delete targetFolderLazyObserverByLora[safeLora];
}

function setupTargetFolderLazyDownloads({ loraName, token, repoId, generation }) {
    const safeLora = String(loraName || '').trim();
    const container = document.getElementById('targetFolderImages');
    if (!safeLora || !container || !token || !repoId) {
        return;
    }

    // Recreate observer each time to capture the latest token/repoId/generation.
    disconnectTargetFolderLazyObserver(safeLora);

    const observer = new IntersectionObserver(
        (entries) => {
            entries.forEach(entry => {
                if (!entry.isIntersecting) {
                    return;
                }

                const tile = entry.target;
                observer.unobserve(tile);

                const path = String(tile?.dataset?.imgPath || '').trim();
                if (!path) {
                    return;
                }

                const currentGen = targetFolderLoadGeneration[safeLora] || 0;
                if (typeof generation === 'number' && generation !== currentGen) {
                    return;
                }

                const entryCache = targetFolderImageCache?.[safeLora]?.[path] || null;
                if (!entryCache || entryCache.objectUrl || entryCache.status === 'error') {
                    return;
                }

                void enqueueTargetFolderImageDownload({
                    loraName: safeLora,
                    path,
                    token,
                    repoId,
                    generation
                });
            });
        },
        {
            root: null,
            rootMargin: '800px',
            threshold: 0.01
        }
    );

    targetFolderLazyObserverByLora[safeLora] = observer;

    const tiles = container.querySelectorAll('.target-folder-item[data-img-path]');
    tiles.forEach(tile => {
        const path = String(tile?.dataset?.imgPath || '').trim();
        if (!path) {
            return;
        }

        const entryCache = targetFolderImageCache?.[safeLora]?.[path] || null;
        if (!entryCache || entryCache.objectUrl || entryCache.status === 'error') {
            return;
        }

        observer.observe(tile);
    });
}

function drainTargetFolderDownloadQueue() {
    while (targetFolderDownloadActiveCount < TARGET_FOLDER_MAX_CONCURRENT_DOWNLOADS
        && targetFolderDownloadQueue.length > 0) {
        const task = targetFolderDownloadQueue.shift();
        if (!task) {
            continue;
        }

        targetFolderDownloadActiveCount += 1;
        const kind = task.kind || 'targetFolder';
        const runner = kind === 'url' ? runUrlImageDownloadTask : runTargetFolderDownloadTask;
        void runner(task)
            .catch(() => {
            })
            .finally(() => {
                targetFolderDownloadActiveCount = Math.max(0, targetFolderDownloadActiveCount - 1);
                drainTargetFolderDownloadQueue();
            });
    }
}

async function runUrlImageDownloadTask(task) {
    const {
        key,
        url,
        headers,
        shouldContinue,
        onStarted,
        onLoaded,
        onError,
        resolve,
        reject
    } = task || {};

    const safeKey = String(key || '').trim();
    const safeUrl = String(url || '').trim();

    try {
        if (!safeKey || !safeUrl) {
            return;
        }

        if (typeof shouldContinue === 'function' && !shouldContinue()) {
            return;
        }

        if (typeof onStarted === 'function') {
            try {
                onStarted();
            } catch (_) {
            }
        }

        const res = await fetch(safeUrl, headers ? { headers } : undefined);
        if (!res.ok) {
            throw new Error(`HTTP ${res.status}`);
        }

        const blob = await res.blob();
        const objectUrl = URL.createObjectURL(blob);

        if (typeof shouldContinue === 'function' && !shouldContinue()) {
            try {
                URL.revokeObjectURL(objectUrl);
            } catch (_) {
            }
            return;
        }

        if (typeof onLoaded === 'function') {
            onLoaded({ blob, objectUrl, url: safeUrl });
        }

        if (typeof resolve === 'function') {
            resolve({ blob, objectUrl, url: safeUrl });
        }
    } catch (error) {
        if (typeof onError === 'function') {
            try {
                onError(error);
            } catch (_) {
            }
        }
        if (typeof reject === 'function') {
            reject(error);
        }
    } finally {
        if (safeKey) {
            targetFolderDownloadPromiseByKey.delete(safeKey);
        }
    }
}

async function runTargetFolderDownloadTask(task) {
    const { loraName, path, token, repoId, generation, resolve } = task || {};
    const safeLora = String(loraName || '').trim();
    const safePath = String(path || '').trim();
    const key = getTargetFolderDownloadKey(safeLora, safePath);

    try {
        const currentGen = targetFolderLoadGeneration[safeLora] || 0;
        if (!safeLora || !safePath || !token || !repoId) {
            return;
        }

        const entry = targetFolderImageCache?.[safeLora]?.[safePath] || null;
        if (!entry) {
            return;
        }

        if (entry.objectUrl && entry.status === 'loaded') {
            return;
        }

        // If a reset happened after enqueue, do not waste work updating stale UI.
        if (typeof generation === 'number' && generation !== currentGen) {
            return;
        }

        const fileRes = await fetch(`https://huggingface.co/${repoId}/resolve/main/${safePath}`, {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });

        const genAfterFetch = targetFolderLoadGeneration[safeLora] || 0;
        if (typeof generation === 'number' && generation !== genAfterFetch) {
            return;
        }

        if (!fileRes.ok) {
            entry.status = 'error';
            updateTargetFolderImageTile(safeLora, entry);
            return;
        }

        const blob = await fileRes.blob();
        const objectUrl = URL.createObjectURL(blob);

        // If a reset happened while decoding, do not attach this URL.
        const genBeforeAttach = targetFolderLoadGeneration[safeLora] || 0;
        if (typeof generation === 'number' && generation !== genBeforeAttach) {
            try {
                URL.revokeObjectURL(objectUrl);
            } catch (_) {
            }
            return;
        }

        entry.objectUrl = objectUrl;
        entry.status = 'loaded';
        updateTargetFolderImageTile(safeLora, entry);
    } finally {
        targetFolderDownloadPromiseByKey.delete(key);
        if (typeof resolve === 'function') {
            resolve();
        }
    }
}

function enqueueTargetFolderImageDownload({ loraName, path, token, repoId, generation }) {
    const safeLora = String(loraName || '').trim();
    const safePath = String(path || '').trim();
    const key = getTargetFolderDownloadKey(safeLora, safePath);

    const existing = targetFolderDownloadPromiseByKey.get(key);
    if (existing) {
        return existing;
    }

    const promise = new Promise((resolve) => {
        targetFolderDownloadQueue.push({
            kind: 'targetFolder',
            loraName: safeLora,
            path: safePath,
            token,
            repoId,
            generation,
            resolve
        });
        drainTargetFolderDownloadQueue();
    });

    targetFolderDownloadPromiseByKey.set(key, promise);
    return promise;
}

function enqueueUrlImageDownload({ key, url, headers, shouldContinue, onStarted, onLoaded, onError }) {
    const safeKey = String(key || '').trim();
    const safeUrl = String(url || '').trim();
    if (!safeKey || !safeUrl) {
        return Promise.reject(new Error('Missing key/url for enqueueUrlImageDownload'));
    }

    const existing = targetFolderDownloadPromiseByKey.get(safeKey);
    if (existing) {
        return existing;
    }

    const promise = new Promise((resolve, reject) => {
        targetFolderDownloadQueue.push({
            kind: 'url',
            key: safeKey,
            url: safeUrl,
            headers: headers || null,
            shouldContinue,
            onStarted,
            onLoaded,
            onError,
            resolve,
            reject
        });
        drainTargetFolderDownloadQueue();
    });

    targetFolderDownloadPromiseByKey.set(safeKey, promise);
    return promise;
}

function extractHfTreeItemTimestampMs(item) {
    if (!item || typeof item !== 'object') {
        return 0;
    }

    const candidates = [
        item.lastCommitDate,
        item.last_commit_date,
        item.lastModified,
        item.last_modified,
        item.updatedAt,
        item.updated_at,
        item.createdAt,
        item.created_at,
        item.commitDate,
        item.commit_date,
        item.date
    ];

    for (const value of candidates) {
        if (!value) {
            continue;
        }

        if (typeof value === 'number' && Number.isFinite(value)) {
            // Some APIs return seconds; others ms.
            return value > 10_000_000_000 ? value : value * 1000;
        }

        if (typeof value === 'string') {
            const parsed = Date.parse(value);
            if (Number.isFinite(parsed)) {
                return parsed;
            }
        }
    }

    // Some HF responses nest commit info.
    const nested = item.lastCommit || item.last_commit || item.commit || null;
    if (nested && typeof nested === 'object') {
        return extractHfTreeItemTimestampMs(nested);
    }

    return 0;
}

async function fetchLoRAFiles(token) {
    const repo = 'Gazai-ai/Gacha-LoRA';

    try {
        await fetchAndLogPrivateTokenFile(repo, token);
        await fetchWorkflowJsonFile(repo, token);

        // Access files in the lora folder
        const treeUrl = `https://huggingface.co/api/models/${repo}/tree/main/lora`;

        const response = await fetch(treeUrl, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Accept': 'application/json'
            }
        });

        if (!response.ok) {
            if (response.status === 401) {
                throw new Error('Token is invalid or expired.');
            } else if (response.status === 404) {
                throw new Error('Repository or lora folder not found.');
            } else {
                throw new Error(`API error: ${response.status}`);
            }
        }

        const data = await response.json();

        // Group files by LoRA name
        const loraGrouped = {};

        if (Array.isArray(data)) {
            data.forEach(item => {
                if (item.type === 'file' && item.path) {
                    const fileName = item.path.split('/').pop();
                    // Extract LoRA name (remove extension and version)
                    const loraName = extractLoRAName(fileName);

                    if (!loraGrouped[loraName]) {
                        loraGrouped[loraName] = {
                            name: loraName,
                            files: [],
                            image: null,
                            safetensors: null,
                            latestTimestampMs: 0
                        };
                    }

                    loraGrouped[loraName].files.push(item);

                    const itemTimestampMs = extractHfTreeItemTimestampMs(item);
                    if (itemTimestampMs > (loraGrouped[loraName].latestTimestampMs || 0)) {
                        loraGrouped[loraName].latestTimestampMs = itemTimestampMs;
                    }

                    // Find image
                    if (/\.(png|jpg|jpeg|webp)$/i.test(fileName)) {
                        loraGrouped[loraName].image = item;
                    }

                    // Find safetensors file
                    if (fileName.endsWith('.safetensors')) {
                        loraGrouped[loraName].safetensors = item;
                    }
                }
            });
        }

        const loraList = Object.values(loraGrouped);
        if (loraList.length === 0) {
            throw new Error('No LoRA files found in the lora folder.');
        }

        // Store data for detail view
        allLoRAData = loraGrouped;

        // Only keep LoRAs with images or safetensors
        const filteredLoraList = loraList.filter(lora => lora.image || lora.safetensors);

        if (filteredLoraList.length === 0) {
            throw new Error('No valid LoRA models found in the lora folder.');
        }

        return filteredLoraList;
    } catch (error) {
        throw new Error(`Unable to fetch file list: ${error.message}`);
    }
}

async function fetchAndLogPrivateTokenFile(repo, token) {
    try {
        const privateTokenPath = 'private token';
        const fileUrl = `https://huggingface.co/${repo}/resolve/main/${encodeURIComponent(privateTokenPath)}`;
        const response = await fetch(fileUrl, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });

        if (!response.ok) {
            console.warn(`Failed to read private token file (HTTP ${response.status})`);
            return;
        }

        const text = await response.text();
        const jsonData = JSON.parse(text);
        privateTokenData = jsonData;
        geminiToken = (jsonData?.gemini || jsonData?.['gemini'] || '').toString().trim();
        console.log('private token JSON:', jsonData);

        if (!geminiToken) {
            console.warn('Gemini token missing in private token file.');
        }
    } catch (error) {
        console.warn('Private token file is not valid JSON or failed to read:', error.message);
    }
}

async function fetchWorkflowJsonFile(repo, token) {
    try {
        const workflowPath = 'workflow.json';
        const fileUrl = `https://huggingface.co/${repo}/resolve/main/${workflowPath}`;
        const response = await fetch(fileUrl, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });

        if (!response.ok) {
            console.warn(`Failed to read workflow.json (HTTP ${response.status})`);
            return;
        }

        const text = await response.text();
        workflowData = JSON.parse(text);
        console.log('workflow.json JSON:', workflowData);
    } catch (error) {
        console.warn('workflow.json is not valid JSON or failed to read:', error.message);
    }
}

function getFileUrl(path) {
    // Build Hugging Face file URL
    return `https://huggingface.co/Gazai-ai/Gacha-LoRA/resolve/main/${path}`;
}

function encodeHfPath(path) {
    const parts = String(path || '').split('/').filter(Boolean);
    return parts.map(part => encodeURIComponent(part)).join('/');
}

async function fetchRepoJsonFile(repoId, filePath, token) {
    const encodedPath = encodeHfPath(filePath);
    const url = `https://huggingface.co/${repoId}/resolve/main/${encodedPath}`;

    const response = await fetch(url, {
        method: 'GET',
        headers: {
            'Authorization': `Bearer ${token}`
        }
    });

    if (response.status === 404) {
        return null;
    }

    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }

    const text = await response.text();
    if (!text.trim()) {
        return [];
    }

    const parsed = JSON.parse(text);
    return parsed;
}

async function getHfHubModule() {
    if (!window[HF_HUB_PROMISE_KEY]) {
        window[HF_HUB_PROMISE_KEY] = import('https://esm.sh/@huggingface/hub');
    }
    return window[HF_HUB_PROMISE_KEY];
}

async function saveScenesFromTable({ type, loraName, tbody, statusElementId, saveButton }) {
    const token = resolvedHfToken;
    const repoId = 'Gazai-ai/Gacha-LoRA';

    if (!token) {
        setStatus(statusElementId, 'Unlock the token before saving.', 'error');
        return;
    }

    const filePath = getScenesFilePath(type, loraName);
    const rows = collectScenesFromTable(tbody);

    saveButton.disabled = true;
    setStatus(statusElementId, `Saving: /${filePath}`, 'loading');

    try {
        const hub = await getHfHubModule();
        const repo = { type: 'model', name: repoId };
        const jsonText = JSON.stringify(rows, null, 2);
        const blob = new Blob([jsonText], { type: 'application/json' });

        await hub.uploadFiles({
            repo,
            accessToken: token,
            files: [
                {
                    path: filePath,
                    content: blob
                }
            ],
            commitTitle: type === 'general'
                ? 'Save general scenes'
                : `Save character scenes for ${sanitizeSceneName(loraName)}`
        });

        setStatus(statusElementId, `Saved: /${filePath} (${rows.length} rows)`, 'success');
    } catch (error) {
        setStatus(statusElementId, `Failed to save: /${filePath} (${error.message})`, 'error');
    } finally {
        saveButton.disabled = false;
    }
}

async function loadDetailJsonAndTargetImages(loraName, loraData) {
    const token = resolvedHfToken;
    const repoId = 'Gazai-ai/Gacha-LoRA';

    const jsonContent = document.getElementById('jsonContent');
    const jsonFile = loraData.files.find(f => f.path.endsWith('.json'));

    if (!jsonFile) {
        if (jsonContent) {
            jsonContent.textContent = 'No JSON file info.';
        }
    } else {
        try {
            const jsonUrl = `https://huggingface.co/${repoId}/resolve/main/${jsonFile.path}`;
            const res = await fetch(jsonUrl, {
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            });

            if (!res.ok) {
                throw new Error(`HTTP ${res.status}`);
            }

            const jsonText = await res.text();
            let formatted = jsonText;

            try {
                formatted = JSON.stringify(JSON.parse(jsonText), null, 2);
            } catch (_) {
            }

            if (jsonContent) {
                jsonContent.textContent = formatted;
            }
        } catch (error) {
            if (jsonContent) {
                jsonContent.textContent = `Failed to load JSON: ${error.message}`;
            }
        }
    }

    await loadTargetFolderImages(loraName, token, { reset: true });
}

async function loadTargetFolderImages(loraName, token, options = {}) {
    const reset = !!options.reset;
    const background = !!options.background;
    const container = document.getElementById('targetFolderImages');
    if (!container) {
        return;
    }

    const repoId = 'Gazai-ai/Gacha-LoRA';
    const targetFolder = `image/${loraName}`;

    if (!loadedTargetFolderImagePaths[loraName]) {
        loadedTargetFolderImagePaths[loraName] = new Set();
    }

    if (!targetFolderImageCache[loraName]) {
        targetFolderImageCache[loraName] = {};
    }

    if (reset) {
        targetFolderLoadGeneration[loraName] = (targetFolderLoadGeneration[loraName] || 0) + 1;
        disconnectTargetFolderLazyObserver(loraName);
        Object.values(targetFolderImageCache[loraName]).forEach(item => {
            if (item?.objectUrl) {
                URL.revokeObjectURL(item.objectUrl);
            }
        });
        loadedTargetFolderImagePaths[loraName].clear();
        targetFolderImageCache[loraName] = {};
        container.innerHTML = '<div class="target-folder-empty">Loading...</div>';
    }

    try {
        const treeUrl = `https://huggingface.co/api/models/${repoId}/tree/main/${targetFolder}`;
        const treeRes = await fetch(treeUrl, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Accept': 'application/json'
            }
        });

        if (treeRes.status === 404) {
            container.innerHTML = '<div class="target-folder-empty">No images in the target folder yet.</div>';
            return;
        }

        if (!treeRes.ok) {
            throw new Error(`HTTP ${treeRes.status}`);
        }

        const data = await treeRes.json();
        const imageItems = (Array.isArray(data) ? data : [])
            .filter(item => item.type === 'file' && /\.(png|jpg|jpeg|webp)$/i.test(item.path));

        if (imageItems.length === 0) {
            container.innerHTML = '<div class="target-folder-empty">No images in the target folder yet.</div>';
            return;
        }

        const knownPaths = loadedTargetFolderImagePaths[loraName];
        const itemsToLoad = reset
            ? imageItems
            : imageItems.filter(item => !knownPaths.has(item.path));

        if (!reset && itemsToLoad.length === 0) {
            renderTargetFolderImages(loraName);
            const generation = targetFolderLoadGeneration[loraName] || 0;
            setupTargetFolderLazyDownloads({ loraName, token, repoId, generation });
            return;
        }

        // Insert UI placeholders first to avoid waiting for all images to load
        for (const item of itemsToLoad) {
            const name = item.path.split('/').pop() || item.path;
            if (!targetFolderImageCache[loraName][item.path]) {
                targetFolderImageCache[loraName][item.path] = {
                    path: item.path,
                    fileName: name,
                    domKey: makeImageDomKey(item.path),
                    objectUrl: null,
                    status: 'loading'
                };
            } else {
                targetFolderImageCache[loraName][item.path].fileName = name;
                targetFolderImageCache[loraName][item.path].domKey = makeImageDomKey(item.path);
                if (!targetFolderImageCache[loraName][item.path].objectUrl) {
                    targetFolderImageCache[loraName][item.path].status = 'loading';
                }
            }

            knownPaths.add(item.path);
        }

        renderTargetFolderImages(loraName);

        // Lazy-load downloads only when tiles become visible to avoid decoding many 4K images at once.
        // Still keep background flag for compatibility; with lazy loading, it simply means we return immediately.
        const generation = targetFolderLoadGeneration[loraName] || 0;
        setupTargetFolderLazyDownloads({ loraName, token, repoId, generation });
        if (background) {
            return;
        }
    } catch (error) {
        container.innerHTML = `<div class="target-folder-empty">Failed to load target folder images: ${escapeHtml(error.message)}</div>`;
    }
}

async function getCharacterFeaturesForLora(loraName) {
    if (loraFeatureCache[loraName]) {
        return loraFeatureCache[loraName];
    }

    const loraData = allLoRAData[loraName];
    const token = resolvedHfToken;
    const repoId = 'Gazai-ai/Gacha-LoRA';
    const jsonFile = loraData?.files?.find(file => file.path.endsWith('.json'));

    if (!jsonFile) {
        loraFeatureCache[loraName] = {
            character_head_features: '',
            character_body_features: '',
            character_clothing_features: ''
        };
        return loraFeatureCache[loraName];
    }

    try {
        const jsonUrl = `https://huggingface.co/${repoId}/resolve/main/${jsonFile.path}`;
        const res = await fetch(jsonUrl, {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });

        if (!res.ok) {
            throw new Error(`HTTP ${res.status}`);
        }

        const parsed = JSON.parse(await res.text());
        loraFeatureCache[loraName] = {
            character_head_features: extractFeatureString(parsed, 'character_head_features'),
            character_body_features: extractFeatureString(parsed, 'character_body_features'),
            character_clothing_features: extractFeatureString(parsed, 'character_clothing_features')
        };
    } catch (error) {
        console.warn(`Failed to read character features JSON (${loraName}):`, error.message);
        loraFeatureCache[loraName] = {
            character_head_features: '',
            character_body_features: '',
            character_clothing_features: ''
        };
    }

    return loraFeatureCache[loraName];
}

function extractFeatureString(jsonObject, key) {
    if (!jsonObject || typeof jsonObject !== 'object') {
        return '';
    }

    const value = jsonObject[key];
    if (typeof value === 'string') {
        return value;
    }

    if (Array.isArray(value)) {
        return value.filter(item => typeof item === 'string').join(', ');
    }

    if (value && typeof value === 'object') {
        const parts = [];
        Object.values(value).forEach(item => {
            if (typeof item === 'string') {
                parts.push(item);
            }
        });
        return parts.join(', ');
    }

    return '';
}
