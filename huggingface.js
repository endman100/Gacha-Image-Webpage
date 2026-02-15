const HF_HUB_PROMISE_KEY = '__hfHubModulePromise';

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
                            safetensors: null
                        };
                    }

                    loraGrouped[loraName].files.push(item);

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

        return filteredLoraList.sort((a, b) => a.name.localeCompare(b.name));
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

        const concurrency = 6;
        let cursor = 0;

        async function downloadWorker() {
            while (cursor < itemsToLoad.length) {
                const current = itemsToLoad[cursor];
                cursor += 1;

                const entry = targetFolderImageCache[loraName][current.path];
                if (!entry || entry.objectUrl) {
                    continue;
                }

                try {
                    const fileRes = await fetch(`https://huggingface.co/${repoId}/resolve/main/${current.path}`, {
                        headers: {
                            'Authorization': `Bearer ${token}`
                        }
                    });

                    if (!fileRes.ok) {
                        entry.status = 'error';
                        updateTargetFolderImageTile(loraName, entry);
                        continue;
                    }

                    const blob = await fileRes.blob();
                    entry.objectUrl = URL.createObjectURL(blob);
                    entry.status = 'loaded';
                    updateTargetFolderImageTile(loraName, entry);
                } catch (_) {
                    entry.status = 'error';
                    updateTargetFolderImageTile(loraName, entry);
                }
            }
        }

        await Promise.all(
            Array.from({ length: Math.min(concurrency, itemsToLoad.length) }, () => downloadWorker())
        );

        // After downloads finish, re-sort once (does not affect loaded images)
        renderTargetFolderImages(loraName);
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
