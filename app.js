const searchBtn = document.getElementById('searchBtn');
const backBtn = document.getElementById('backBtn');
const mainView = document.getElementById('mainView');
const detailView = document.getElementById('detailView');
const results = document.getElementById('results');
const loading = document.getElementById('loading');
const gallery = document.getElementById('gallery');
const galleryContainer = document.getElementById('gallery-container');
const errorMessage = document.getElementById('error-message');
const successMessage = document.getElementById('success-message');
const detailTitle = document.getElementById('detailTitle');
    const unlockPasswordInput = document.getElementById('unlockPassword');
            const UNLOCK_PASSWORD_COOKIE_KEY = 'unlockPassword';
            const UNLOCK_PASSWORD_COOKIE_DAYS = 30;
    const ENCRYPTED_HF_TOKEN = {
        salt: 'ijN318FRb0T1IkFERq5V3Q==',
        iv: 'lz07vwtQAGQW0ZtI',
        ciphertext: 'mJ4z8Hac7nXJfZfnC0iYnaUCRH3Eg4Pgyw3FulpV1Xys+Y+rOg==',
        tag: 'GG0FmTgJ5kQbHHYbbqlPuA==',
        iterations: 150000,
        hash: 'SHA-256'
    };

let allLoRAData = {}; // Store all LoRA data
let privateTokenData = null;
let workflowData = null;
let resolvedHfToken = '';
const loadedTargetFolderImagePaths = {};
const targetFolderImageCache = {};
const targetFolderSortOrder = {};
const loraFeatureCache = {};
let lightboxState = { images: [], index: 0 };

searchBtn.addEventListener('click', searchLoRAFiles);
unlockPasswordInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        searchLoRAFiles();
    }
});
unlockPasswordInput.addEventListener('input', () => {
    saveUnlockPasswordToCookie(unlockPasswordInput.value);
});

backBtn.addEventListener('click', backToMainView);
setupTargetFolderImageZoom();

const hasSavedUnlockPassword = restoreUnlockPasswordFromCookie();
if (hasSavedUnlockPassword) {
    searchLoRAFiles();
}

function saveUnlockPasswordToCookie(password) {
    const expiresAt = new Date(Date.now() + UNLOCK_PASSWORD_COOKIE_DAYS * 24 * 60 * 60 * 1000).toUTCString();
    document.cookie = `${UNLOCK_PASSWORD_COOKIE_KEY}=${encodeURIComponent(password || '')}; path=/; expires=${expiresAt}; SameSite=Lax`;
}

function getCookieValue(name) {
    const cookiePrefix = `${name}=`;
    const cookieParts = document.cookie.split(';');

    for (const part of cookieParts) {
        const cookie = part.trim();
        if (cookie.startsWith(cookiePrefix)) {
            return decodeURIComponent(cookie.substring(cookiePrefix.length));
        }
    }

    return '';
}

function restoreUnlockPasswordFromCookie() {
    const savedPassword = getCookieValue(UNLOCK_PASSWORD_COOKIE_KEY);
    if (savedPassword && !unlockPasswordInput.value) {
        unlockPasswordInput.value = savedPassword;
        return true;
    }

    return false;
}

function base64ToBytes(base64Text) {
    const binary = atob(base64Text);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
}

async function decryptEmbeddedHfToken(password) {
    if (!window.crypto || !window.crypto.subtle) {
        throw new Error('Web Crypto is not supported in this browser; cannot decrypt the embedded token.');
    }

    const encoder = new TextEncoder();
    const passwordKey = await window.crypto.subtle.importKey(
        'raw',
        encoder.encode(password),
        { name: 'PBKDF2' },
        false,
        ['deriveKey']
    );

    const aesKey = await window.crypto.subtle.deriveKey(
        {
            name: 'PBKDF2',
            salt: base64ToBytes(ENCRYPTED_HF_TOKEN.salt),
            iterations: ENCRYPTED_HF_TOKEN.iterations,
            hash: ENCRYPTED_HF_TOKEN.hash
        },
        passwordKey,
        {
            name: 'AES-GCM',
            length: 256
        },
        false,
        ['decrypt']
    );

    const encryptedBytes = base64ToBytes(ENCRYPTED_HF_TOKEN.ciphertext);
    const tagBytes = base64ToBytes(ENCRYPTED_HF_TOKEN.tag);
    const combinedBytes = new Uint8Array(encryptedBytes.length + tagBytes.length);
    combinedBytes.set(encryptedBytes, 0);
    combinedBytes.set(tagBytes, encryptedBytes.length);

    const decryptedBuffer = await window.crypto.subtle.decrypt(
        {
            name: 'AES-GCM',
            iv: base64ToBytes(ENCRYPTED_HF_TOKEN.iv)
        },
        aesKey,
        combinedBytes
    );

    const decoder = new TextDecoder();
    return decoder.decode(decryptedBuffer).trim();
}

async function resolveTokenForSearch() {
    const password = (unlockPasswordInput?.value || '').trim();
    if (!password) {
        throw new Error('Please enter the decryption password.');
    }

    try {
        const decryptedToken = await decryptEmbeddedHfToken(password);
        if (!decryptedToken) {
            throw new Error('Decrypted token is empty.');
        }
        resolvedHfToken = decryptedToken;
        return decryptedToken;
    } catch (_) {
        throw new Error('Decryption failed: incorrect password or data cannot be decrypted.');
    }
}

async function searchLoRAFiles() {
    let token = '';

    try {
        token = await resolveTokenForSearch();
    } catch (error) {
        showError(error.message);
        return;
    }

    // Validate token
    if (!token) {
        showError('Unable to obtain Hugging Face token.');
        return;
    }

    // Clear previous results
    gallery.innerHTML = '';
    errorMessage.innerHTML = '';
    successMessage.innerHTML = '';
    galleryContainer.style.display = 'none';
    allLoRAData = {};

    // Show loading state
    results.classList.add('show');
    loading.style.display = 'block';
    searchBtn.disabled = true;

    try {
        const loraList = await fetchLoRAFiles(token);
        
        if (loraList.length === 0) {
            showError('No LoRA files found in the lora folder.');
        } else {
            displayGallery(loraList);
            successMessage.innerHTML = '<div class="success">✓ LoRA models found.</div>';
        }
    } catch (error) {
        console.error('Error:', error);
        showError(error.message);
    } finally {
        loading.style.display = 'none';
        searchBtn.disabled = false;
    }
}


function extractLoRAName(fileName) {
    // Remove extension
    let name = fileName.replace(/\.[^.]+$/, '');
    // Split by "_" or "-" and take the first part
    name = name.split(/[_-]/)[0];
    return name;
}

function displayGallery(loraList) {
    galleryContainer.style.display = 'block';
    gallery.innerHTML = '';

    loraList.forEach(lora => {
        const block = document.createElement('div');
        block.className = 'lora-block';
        
        let imageHtml = '';
        if (lora.image) {
            const imageUrl = getFileUrl(lora.image.path);
            imageHtml = `<img src="${imageUrl}" alt="${escapeHtml(lora.name)}" class="lora-image">`;
        } else {
            imageHtml = `<div class="no-image">No preview image</div>`;
        }

        block.innerHTML = `
            ${imageHtml}
            <div class="lora-name-overlay">${escapeHtml(lora.name)}</div>
        `;
        
        block.addEventListener('click', () => openDetailView(lora.name));
        gallery.appendChild(block);
    });
}

function openDetailView(loraName) {
    mainView.style.display = 'none';
    detailView.classList.add('active');
    detailTitle.textContent = loraName;

    if (!targetFolderSortOrder[loraName]) {
        targetFolderSortOrder[loraName] = 'asc';
    }
    
    const loraData = allLoRAData[loraName];
    const detailContent = document.getElementById('detailContent');
    
    // Row 1: Image, group name, and JSON info
    let html = '<div class="detail-row">';
    html += '<h3>📋 Model Info</h3>';
    html += '<div class="image-json-container">';
    
    // Image section
    if (loraData.image) {
        const imageUrl = getFileUrl(loraData.image.path);
        html += `<img src="${imageUrl}" alt="${escapeHtml(loraName)}" class="preview-image">`;
    } else {
        html += '<div class="preview-image" style="background: #f0f0f0; display: flex; align-items: center; justify-content: center;">No preview image</div>';
    }
    
    html += '<div class="json-info"><pre id="jsonContent">Loading JSON content...</pre></div></div></div>';

    // Row 2: General character scenes (separate layout, above Workflow settings)
    html += '<div class="detail-row">';
    html += '<h3>🧩 General Character Scenes</h3>';
    html += '<div class="scene-section" id="generalScenesSection">';
    html += '<div class="scene-header"></div>';
    html += '<div class="scene-table-wrapper">';
    html += '<table class="scene-table">';
    html += '<thead><tr><th>Scene Design</th><th>Prompt</th><th>Keep Outfit Design</th><th>Actions</th></tr></thead>';
    html += '<tbody id="generalScenesTbody"></tbody>';
    html += '</table>';
    html += '</div>';
    html += '<div class="scene-footer">';
    html += '<button class="upload-btn scene-btn" id="saveGeneralScenesBtn" type="button">Save</button>';
    html += '<button class="sort-btn scene-btn" id="addGeneralScenesRowBtn" type="button">Add Row</button>';
    html += '<button class="sort-btn scene-btn scene-ai-btn" id="addGeneralScenesRowAiBtn" type="button">Add Row By AI</button>';
    html += '</div>';
    html += '<div id="generalScenesStatus" class="upload-status"></div>';
    html += '</div>';
    html += '</div>';

    // Row 3: Character-specific scenes (separate layout, above Workflow settings)
    html += '<div class="detail-row">';
    html += '<h3>🧩 Character-Specific Scenes</h3>';
    html += '<div class="scene-section" id="characterScenesSection">';
    html += '<div class="scene-header"></div>';
    html += '<div class="scene-table-wrapper">';
    html += '<table class="scene-table">';
    html += '<thead><tr><th>Scene Design</th><th>Prompt</th><th>Keep Outfit Design</th><th>Actions</th></tr></thead>';
    html += '<tbody id="characterScenesTbody"></tbody>';
    html += '</table>';
    html += '</div>';
    html += '<div class="scene-footer">';
    html += '<button class="upload-btn scene-btn" id="saveCharacterScenesBtn" type="button">Save</button>';
    html += '<button class="sort-btn scene-btn" id="addCharacterScenesRowBtn" type="button">Add Row</button>';
    html += '<button class="sort-btn scene-btn scene-ai-btn" id="addCharacterScenesRowAiBtn" type="button">Add Row By AI</button>';
    html += '</div>';
    html += '<div id="characterScenesStatus" class="upload-status"></div>';
    html += '</div>';
    html += '</div>';

    // Row 4: Workflow settings
    html += '<div class="detail-row">';
    html += '<h3>⚙️ Workflow Settings</h3>';
    html += '<div class="upload-container">';
    html += '<div class="upload-input-group">';
    html += '<label for="uploadTimes">Runs:</label>';
    html += '<input type="number" id="uploadTimes" min="1" max="100" value="1">';
    html += '</div>';
    html += '<button class="upload-btn" id="runpodBtn">Generate Gacha</button>';
    html += '</div>';
    html += '<div id="runpodStatus" class="upload-status"></div>';
    html += '</div>';

    // Row 5: Result images
    html += '<div class="detail-row">';
    html += '<h3>🖼️ Result Images</h3>';
    html += `<div class="target-folder-section">`;
    html += '<div class="target-folder-toolbar">';
    html += `<div class="target-folder-title">Result Images: /image/${escapeHtml(loraName)}</div>`;
    html += `<button id="sortImagesBtn" class="sort-btn">Sort: ${targetFolderSortOrder[loraName] === 'asc' ? 'Ascending' : 'Descending'}</button>`;
    html += '</div>';
    html += '<div id="targetFolderImages" class="target-folder-images"><div class="target-folder-empty">Loading...</div></div>';
    html += '</div>';
    html += '</div>';
    
    detailContent.innerHTML = html;
    
    document.getElementById('runpodBtn').addEventListener('click', () => runWorkflowWithRunpod(loraName));
    setupSceneEditors(loraName);
    document.getElementById('sortImagesBtn').addEventListener('click', () => {
        targetFolderSortOrder[loraName] = targetFolderSortOrder[loraName] === 'asc' ? 'desc' : 'asc';
        updateSortButtonText(loraName);
        renderTargetFolderImages(loraName);
    });

    updateSortButtonText(loraName);

    loadDetailJsonAndTargetImages(loraName, loraData);
}

function setupSceneEditors(loraName) {
    const generalTbody = document.getElementById('generalScenesTbody');
    const characterTbody = document.getElementById('characterScenesTbody');

    const saveGeneralBtn = document.getElementById('saveGeneralScenesBtn');
    const addGeneralBtn = document.getElementById('addGeneralScenesRowBtn');
    const addGeneralAiBtn = document.getElementById('addGeneralScenesRowAiBtn');
    const saveCharacterBtn = document.getElementById('saveCharacterScenesBtn');
    const addCharacterBtn = document.getElementById('addCharacterScenesRowBtn');
    const addCharacterAiBtn = document.getElementById('addCharacterScenesRowAiBtn');

    if (!generalTbody || !characterTbody || !saveGeneralBtn || !addGeneralBtn || !addGeneralAiBtn || !saveCharacterBtn || !addCharacterBtn || !addCharacterAiBtn) {
        return;
    }

    addGeneralBtn.addEventListener('click', () => {
        appendSceneRow(generalTbody, { scenes: '', prompt: '', keepClothes: false });
    });

    addCharacterBtn.addEventListener('click', () => {
        appendSceneRow(characterTbody, { scenes: '', prompt: '', keepClothes: false });
    });

    addGeneralAiBtn.addEventListener('click', async () => {
        await addSceneRowByAi({ tbody: generalTbody, triggerBtn: addGeneralAiBtn });
    });

    addCharacterAiBtn.addEventListener('click', async () => {
        await addSceneRowByAi({ tbody: characterTbody, triggerBtn: addCharacterAiBtn });
    });

    saveGeneralBtn.addEventListener('click', async () => {
        await saveScenesFromTable({
            loraName,
            tbody: generalTbody,
            statusElementId: 'generalScenesStatus',
            saveButton: saveGeneralBtn,
            type: 'general'
        });
    });

    saveCharacterBtn.addEventListener('click', async () => {
        await saveScenesFromTable({
            loraName,
            tbody: characterTbody,
            statusElementId: 'characterScenesStatus',
            saveButton: saveCharacterBtn,
            type: 'character'
        });
    });

    // Insert a blank row first to avoid an empty table during loading
    appendSceneRow(generalTbody, { scenes: '', prompt: '', keepClothes: false });
    appendSceneRow(characterTbody, { scenes: '', prompt: '', keepClothes: false });

    void loadScenesIntoTable({ type: 'general', loraName, tbody: generalTbody, statusElementId: 'generalScenesStatus' });
    void loadScenesIntoTable({ type: 'character', loraName, tbody: characterTbody, statusElementId: 'characterScenesStatus' });
}

function appendSceneRow(tbody, row) {
    const normalized = normalizeSceneRow(row);

    const tr = document.createElement('tr');
    tr.className = 'scene-row';

    const scenesTd = document.createElement('td');
    const scenesInput = document.createElement('textarea');
    scenesInput.className = 'scene-textarea';
    scenesInput.value = normalized.scenes;
    scenesInput.placeholder = 'Enter scene design';
    scenesInput.addEventListener('input', () => autoResizeTextarea(scenesInput));
    scenesTd.appendChild(scenesInput);

    const keepTd = document.createElement('td');
    keepTd.className = 'scene-checkbox-cell';
    const keepInput = document.createElement('input');
    keepInput.type = 'checkbox';
    keepInput.checked = normalized.keepClothes;
    keepInput.className = 'scene-checkbox';
    keepInput.title = 'Keep outfit design';
    keepTd.appendChild(keepInput);

    const promptTd = document.createElement('td');
    const promptInput = document.createElement('textarea');
    promptInput.className = 'scene-textarea';
    promptInput.value = normalized.prompt;
    promptInput.placeholder = 'Enter prompt';
    promptInput.addEventListener('input', () => autoResizeTextarea(promptInput));
    promptTd.appendChild(promptInput);

    const actionTd = document.createElement('td');
    actionTd.className = 'scene-action-cell';
    const actionStack = document.createElement('div');
    actionStack.className = 'scene-action-stack';
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'scene-remove-btn';
    removeBtn.textContent = 'Remove';
    removeBtn.title = 'Remove this row';
    removeBtn.addEventListener('click', () => {
        tr.remove();
        if (!tbody.querySelector('tr.scene-row')) {
            appendSceneRow(tbody, { scenes: '', prompt: '', keepClothes: false });
        }
    });
    const convertBtn = document.createElement('button');
    convertBtn.type = 'button';
    convertBtn.className = 'scene-gemini-btn';
    convertBtn.textContent = 'Convert to Prompt';
    convertBtn.title = 'Use Gemini to convert the scene design into a prompt';
    convertBtn.addEventListener('click', async () => {
        const sceneText = scenesInput.value.trim();
        if (!sceneText) {
            window.alert('Please enter a scene design first.');
            return;
        }

        const previousPrompt = promptInput.value;
        const originalLabel = convertBtn.textContent;
        convertBtn.disabled = true;
        convertBtn.textContent = 'Generating...';

        try {
            promptInput.value = '';
            const finalPrompt = await requestGeminiPromptStream(sceneText, (chunk) => {
                const nextValue = `${promptInput.value}${chunk}`;
                promptInput.value = nextValue.replace(/\s+/g, ' ').trimStart();
                autoResizeTextarea(promptInput);
            });
            if (finalPrompt) {
                promptInput.value = finalPrompt;
                autoResizeTextarea(promptInput);
            }
        } catch (error) {
            promptInput.value = previousPrompt;
            autoResizeTextarea(promptInput);
            console.error('Gemini prompt error:', error);
            window.alert(`Gemini error: ${error.message}`);
        } finally {
            convertBtn.disabled = false;
            convertBtn.textContent = originalLabel;
        }
    });

    actionStack.append(removeBtn, convertBtn);
    actionTd.appendChild(actionStack);

    tr.append(scenesTd, promptTd, keepTd, actionTd);
    tbody.appendChild(tr);

    autoResizeTextarea(scenesInput);
    autoResizeTextarea(promptInput);

    return { tr, scenesInput, promptInput };
}

async function addSceneRowByAi({ tbody, triggerBtn }) {
    if (!tbody || !triggerBtn) {
        return;
    }

    const originalLabel = triggerBtn.textContent;
    triggerBtn.disabled = true;
    triggerBtn.textContent = 'Generating...';

    const row = appendSceneRow(tbody, { scenes: '', prompt: '', keepClothes: false });
    if (!row) {
        triggerBtn.disabled = false;
        triggerBtn.textContent = originalLabel;
        return;
    }

    const { scenesInput, promptInput } = row;
    const previousScene = scenesInput.value;
    const previousPrompt = promptInput.value;

    try {
        const sceneText = await requestGeminiSceneDesign();
        if (sceneText) {
            scenesInput.value = sceneText;
            autoResizeTextarea(scenesInput);
        }

        promptInput.value = '';
        const finalPrompt = await requestGeminiPromptStream(sceneText, (chunk) => {
            const nextValue = `${promptInput.value}${chunk}`;
            promptInput.value = nextValue.replace(/\s+/g, ' ').trimStart();
            autoResizeTextarea(promptInput);
        });
        if (finalPrompt) {
            promptInput.value = finalPrompt;
            autoResizeTextarea(promptInput);
        }
    } catch (error) {
        scenesInput.value = previousScene;
        promptInput.value = previousPrompt;
        autoResizeTextarea(scenesInput);
        autoResizeTextarea(promptInput);
        console.error('Gemini AI row error:', error);
        window.alert(`Gemini error: ${error.message}`);
    } finally {
        triggerBtn.disabled = false;
        triggerBtn.textContent = originalLabel;
    }
}

function autoResizeTextarea(textarea) {
    if (!textarea) {
        return;
    }

    textarea.style.height = 'auto';
    textarea.style.height = `${textarea.scrollHeight}px`;
}

function normalizeSceneRow(row) {
    const scenes = (row?.scenes ?? row?.scene ?? row?.['scene design'] ?? '').toString();
    const prompt = (row?.prompt ?? '').toString();
    const keepClothes = !!(row?.keepClothes ?? row?.keep_clothes ?? row?.['change clothes']);
    return { scenes, prompt, keepClothes };
}

function collectScenesFromTable(tbody) {
    const rows = Array.from(tbody.querySelectorAll('tr.scene-row'));
    const result = [];

    for (const tr of rows) {
        const textareas = tr.querySelectorAll('textarea.scene-textarea');
        const checkbox = tr.querySelector('input.scene-checkbox');
        const scenes = (textareas?.[0]?.value || '').trim();
        const prompt = (textareas?.[1]?.value || '').trim();
        const keepClothes = !!checkbox?.checked;

        // Skip fully empty rows
        if (!scenes && !prompt && !keepClothes) {
            continue;
        }

        result.push({
            scenes,
            prompt,
            // Required key name
            'change clothes': keepClothes
        });
    }

    return result;
}

function setStatus(elementId, message, type) {
    const el = document.getElementById(elementId);
    if (!el) {
        return;
    }

    el.textContent = message;
    el.className = `upload-status show ${type}`;
}

function sanitizeSceneName(name) {
    return String(name || '')
        .replace(/[\\/]/g, '_')
        .replace(/\.{2,}/g, '_')
        .trim();
}

function getScenesFilePath(type, loraName) {
    if (type === 'general') {
        return 'general scenes.json';
    }

    const safeName = sanitizeSceneName(loraName);
    return `character scenes/${safeName}.json`;
}

function normalizeScenesFileContent(raw) {
    const list = Array.isArray(raw) ? raw : [];
    return list.map(item => ({
        scenes: (item?.scenes ?? '').toString(),
        prompt: (item?.prompt ?? '').toString(),
        keepClothes: !!item?.['change clothes']
    }));
}

async function loadScenesIntoTable({ type, loraName, tbody, statusElementId }) {
    const token = resolvedHfToken;
    const repoId = 'Gazai-ai/Gacha-LoRA';

    if (!token) {
        setStatus(statusElementId, 'Unlock the token before loading.', 'error');
        return;
    }

    const filePath = getScenesFilePath(type, loraName);
    setStatus(statusElementId, `Loading: /${filePath}`, 'loading');

    try {
        const json = await fetchRepoJsonFile(repoId, filePath, token);
        const rows = normalizeScenesFileContent(json);

        tbody.innerHTML = '';
        if (rows.length === 0) {
            appendSceneRow(tbody, { scenes: '', prompt: '', keepClothes: false });
            setStatus(statusElementId, `No data yet: /${filePath}`, 'loading');
            return;
        }

        rows.forEach(row => appendSceneRow(tbody, row));
        setStatus(statusElementId, `Loaded: /${filePath} (${rows.length} rows)`, 'success');
    } catch (error) {
        // Parse failure or permission issue
        setStatus(statusElementId, `Failed to load: /${filePath} (${error.message})`, 'error');
    }
}

function updateSortButtonText(loraName) {
    const sortBtn = document.getElementById('sortImagesBtn');
    if (!sortBtn) {
        return;
    }

    sortBtn.textContent = `Sort: ${targetFolderSortOrder[loraName] === 'asc' ? 'Ascending' : 'Descending'}`;
}

function compareImageName(a, b) {
    return a.fileName.localeCompare(b.fileName, undefined, { numeric: true, sensitivity: 'base' });
}

function renderTargetFolderImages(loraName) {
    const container = document.getElementById('targetFolderImages');
    if (!container) {
        return;
    }

    container.dataset.loraName = loraName;

    const imagesMap = targetFolderImageCache[loraName] || {};
    const imageList = Object.values(imagesMap);

    if (imageList.length === 0) {
        container.innerHTML = '<div class="target-folder-empty">No images in the target folder yet.</div>';
        return;
    }

    imageList.sort(compareImageName);
    if (targetFolderSortOrder[loraName] === 'desc') {
        imageList.reverse();
    }

    container.innerHTML = imageList
        .map(item => {
            const domKey = item.domKey || makeImageDomKey(item.path);
            const status = item.status || (item.objectUrl ? 'loaded' : 'loading');

            if (status === 'loaded' && item.objectUrl) {
                return `<div class="target-folder-item" data-img-key="${domKey}"><img src="${item.objectUrl}" alt="${escapeHtml(item.fileName)}"></div>`;
            }

            if (status === 'error') {
                return `<div class="target-folder-item" data-img-key="${domKey}"><div class="target-folder-loading is-error">Load failed</div></div>`;
            }

            return `<div class="target-folder-item" data-img-key="${domKey}"><div class="target-folder-loading"><div class="mini-spinner"></div><div class="loading-text">Loading...</div></div></div>`;
        })
        .join('');
}

function setupTargetFolderImageZoom() {
    document.addEventListener('click', (event) => {
        console.log('[zoom] click target:', event.target);
        const clickedTile = event.target.closest('.target-folder-item');
        if (!clickedTile) {
            console.log('[zoom] no target-folder image found for this click');
            return;
        }

        const clickedImage = clickedTile.querySelector('img');
        const container = clickedTile.closest('#targetFolderImages');
        const fallbackName = detailTitle ? detailTitle.textContent : '';
        const loraName = container && container.dataset.loraName
            ? container.dataset.loraName
            : (fallbackName || '').trim();
        const domKey = clickedTile.dataset.imgKey || '';

        console.log('[zoom] open lightbox for:', clickedImage ? clickedImage.src : '(loading)');
        openImageLightbox({
            src: clickedImage ? clickedImage.src : '',
            altText: clickedImage ? clickedImage.alt || '' : '',
            loraName,
            domKey
        });
    });

    document.addEventListener('keydown', (event) => {
        if (!isLightboxActive()) {
            return;
        }

        if (event.key === 'ArrowLeft') {
            event.preventDefault();
            navigateLightbox(-1);
        }

        if (event.key === 'ArrowRight') {
            event.preventDefault();
            navigateLightbox(1);
        }
    });
}

function isLightboxActive() {
    const lightbox = document.querySelector('.image-lightbox');
    return Boolean(lightbox && lightbox.classList.contains('is-active'));
}

function getTargetFolderImageList(loraName) {
    let resolvedName = loraName;
    if (!resolvedName) {
        const container = document.getElementById('targetFolderImages');
        resolvedName = container && container.dataset.loraName ? container.dataset.loraName : '';
    }

    if (resolvedName && targetFolderImageCache[resolvedName]) {
        const imagesMap = targetFolderImageCache[resolvedName] || {};
        const imageList = Object.values(imagesMap);

        imageList.sort(compareImageName);
        if (targetFolderSortOrder[resolvedName] === 'desc') {
            imageList.reverse();
        }

        return imageList.map(item => ({
            src: item.objectUrl || '',
            alt: item.fileName || '',
            status: item.status || (item.objectUrl ? 'loaded' : 'loading'),
            domKey: item.domKey || makeImageDomKey(item.path)
        }));
    }

    const tiles = document.querySelectorAll('#targetFolderImages .target-folder-item');
    return Array.from(tiles).map(tile => {
        const img = tile.querySelector('img');
        return {
            src: img ? img.src : '',
            alt: img ? img.alt || '' : '',
            status: img ? 'loaded' : 'loading',
            domKey: tile.dataset.imgKey || ''
        };
    });
}

function ensureImageLightbox() {
    let lightbox = document.querySelector('.image-lightbox');
    if (lightbox) {
        return lightbox;
    }

    lightbox = document.createElement('div');
    lightbox.className = 'image-lightbox';
    lightbox.innerHTML = `
        <button class="lightbox-nav lightbox-prev" type="button" aria-label="Previous image">&lt;</button>
        <img class="lightbox-main" src="" alt="">
        <div class="lightbox-loading" aria-live="polite">
            <div class="mini-spinner"></div>
            <div class="loading-text">Loading...</div>
        </div>
        <button class="lightbox-nav lightbox-next" type="button" aria-label="Next image">&gt;</button>
        <div class="lightbox-thumbs" aria-label="Thumbnail list"></div>
    `;
    lightbox.addEventListener('click', (event) => {
        if (event.target === lightbox) {
            closeImageLightbox();
        }
    });

    const prevBtn = lightbox.querySelector('.lightbox-prev');
    const nextBtn = lightbox.querySelector('.lightbox-next');

    if (prevBtn) {
        prevBtn.addEventListener('click', (event) => {
            event.stopPropagation();
            navigateLightbox(-1);
        });
    }

    if (nextBtn) {
        nextBtn.addEventListener('click', (event) => {
            event.stopPropagation();
            navigateLightbox(1);
        });
    }

    document.body.appendChild(lightbox);
    return lightbox;
}

function openImageLightbox({ src, altText, loraName, domKey }) {
    const lightbox = ensureImageLightbox();
    const images = getTargetFolderImageList(loraName);
    let index = -1;

    if (domKey) {
        index = images.findIndex(item => item.domKey === domKey);
    }

    if (index < 0 && src) {
        index = images.findIndex(item => item.src === src);
    }

    if (index < 0) {
        index = 0;
    }

    if (!images.length) {
        images.push({
            src: src || '',
            alt: altText || '',
            status: 'loading',
            domKey: domKey || ''
        });
        index = 0;
    }

    lightboxState = {
        images,
        index
    };

    updateLightboxMainDisplay();
    renderLightboxThumbnails();
    updateLightboxNavState();
    lightbox.classList.add('is-active');
    document.body.classList.add('no-scroll');
}

function navigateLightbox(direction) {
    if (!lightboxState.images.length) {
        return;
    }

    const total = lightboxState.images.length;
    const nextIndex = (lightboxState.index + direction + total) % total;
    lightboxState.index = nextIndex;

    const lightbox = document.querySelector('.image-lightbox');
    if (lightbox) {
        updateLightboxMainDisplay();
    }

    renderLightboxThumbnails();
    updateLightboxNavState();
}

function updateLightboxMainDisplay() {
    const lightbox = document.querySelector('.image-lightbox');
    if (!lightbox) {
        return;
    }

    const image = lightbox.querySelector('.lightbox-main');
    const loading = lightbox.querySelector('.lightbox-loading');
    const activeImage = lightboxState.images[lightboxState.index];
    const isLoaded = Boolean(activeImage && activeImage.status === 'loaded' && activeImage.src);

    if (image) {
        if (isLoaded) {
            image.src = activeImage.src;
            image.alt = activeImage.alt || '';
            image.style.visibility = 'visible';
        } else {
            image.removeAttribute('src');
            image.alt = activeImage ? activeImage.alt || '' : '';
            image.style.visibility = 'hidden';
        }
    }

    if (loading) {
        loading.classList.toggle('is-visible', !isLoaded);
    }
}

function renderLightboxThumbnails() {
    const lightbox = document.querySelector('.image-lightbox');
    if (!lightbox) {
        return;
    }

    const thumbContainer = lightbox.querySelector('.lightbox-thumbs');
    if (!thumbContainer) {
        return;
    }

    if (!lightboxState.images.length) {
        thumbContainer.innerHTML = '';
        return;
    }

    thumbContainer.innerHTML = lightboxState.images
        .map((item, idx) => {
            const isActive = idx === lightboxState.index ? 'is-active' : '';
            const isLoading = !item.src || item.status !== 'loaded';
            return `
                <button class="lightbox-thumb ${isActive} ${isLoading ? 'is-loading' : ''}" type="button" data-thumb-index="${idx}" aria-label="Image ${idx + 1}">
                    ${isLoading
                        ? '<div class="lightbox-thumb-loading"><div class="mini-spinner"></div></div>'
                        : `<img src="${item.src}" alt="${escapeHtml(item.alt || '')}">`
                    }
                </button>
            `;
        })
        .join('');

    thumbContainer.querySelectorAll('.lightbox-thumb').forEach(button => {
        button.addEventListener('click', (event) => {
            event.stopPropagation();
            const index = Number(button.dataset.thumbIndex || 0);
            if (Number.isNaN(index)) {
                return;
            }
            lightboxState.index = index;
            navigateLightbox(0);
        });
    });
}

function updateLightboxNavState() {
    const lightbox = document.querySelector('.image-lightbox');
    if (!lightbox) {
        return;
    }

    const prevBtn = lightbox.querySelector('.lightbox-prev');
    const nextBtn = lightbox.querySelector('.lightbox-next');
    const isSingle = lightboxState.images.length <= 1;

    if (prevBtn) {
        prevBtn.disabled = isSingle;
    }

    if (nextBtn) {
        nextBtn.disabled = isSingle;
    }
}

function closeImageLightbox() {
    const lightbox = document.querySelector('.image-lightbox');
    if (!lightbox) {
        return;
    }

    lightbox.classList.remove('is-active');
    document.body.classList.remove('no-scroll');
}

function makeImageDomKey(path) {
    try {
        return encodeURIComponent(path || '');
    } catch (_) {
        return String(path || '');
    }
}

function updateTargetFolderImageTile(loraName, entry) {
    const container = document.getElementById('targetFolderImages');
    if (!container || !entry) {
        return;
    }

    const domKey = entry.domKey || makeImageDomKey(entry.path);
    const tile = container.querySelector(`[data-img-key="${domKey}"]`);
    if (!tile) {
        return;
    }

    if (entry.status === 'loaded' && entry.objectUrl) {
        tile.innerHTML = `<img src="${entry.objectUrl}" alt="${escapeHtml(entry.fileName)}">`;
    } else if (entry.status === 'error') {
        tile.innerHTML = `<div class="target-folder-loading is-error">Load failed</div>`;
    } else {
        tile.innerHTML = `<div class="target-folder-loading"><div class="mini-spinner"></div><div class="loading-text">Loading...</div></div>`;
    }

    if (!isLightboxActive()) {
        return;
    }

    const matchIndex = lightboxState.images.findIndex(item => item.domKey === domKey);
    if (matchIndex < 0) {
        return;
    }

    lightboxState.images[matchIndex] = {
        src: entry.objectUrl || '',
        alt: entry.fileName || '',
        status: entry.status || (entry.objectUrl ? 'loaded' : 'loading'),
        domKey
    };

    if (matchIndex === lightboxState.index) {
        updateLightboxMainDisplay();
    }

    renderLightboxThumbnails();
}

function backToMainView() {
    mainView.style.display = 'block';
    detailView.classList.remove('active');
}

function showError(message) {
    results.classList.add('show');
    errorMessage.innerHTML = `<div class="error">✗ ${escapeHtml(message)}</div>`;
    galleryContainer.style.display = 'none';
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function formatFileSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}
