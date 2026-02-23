const searchBtn = document.getElementById('searchBtn');
const backBtn = document.getElementById('backBtn');
const mainView = document.getElementById('mainView');
const detailView = document.getElementById('detailView');
const results = document.getElementById('results');
const loading = document.getElementById('loading');
const gallery = document.getElementById('gallery');
const galleryContainer = document.getElementById('gallery-container');
const sortLoraBtn = document.getElementById('sortLoraBtn');
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
let currentLoraList = [];
let loraCardSortOrder = 'desc';
const loadedTargetFolderImagePaths = {};
const targetFolderImageCache = {};
const targetFolderSortOrder = {};
const loraFeatureCache = {};
const loraCardImageCache = {};
let lightboxState = { images: [], index: 0 };

let loraCardLoadGeneration = 0;

function getLoraCardDownloadKey(loraName, imageUrl) {
    return `${String(loraName || '')}::${String(imageUrl || '')}`;
}

function clearLoraCardPreviewImagesAndCache() {
    loraCardLoadGeneration += 1;

    Object.values(loraCardImageCache).forEach(entry => {
        if (entry?.objectUrl) {
            try {
                URL.revokeObjectURL(entry.objectUrl);
            } catch (_) {
            }
        }
    });
    Object.keys(loraCardImageCache).forEach(key => delete loraCardImageCache[key]);

    document.querySelectorAll('.lora-block').forEach(block => {
        block.querySelectorAll('img.lora-image').forEach(img => img.remove());
        block.querySelectorAll('.no-image').forEach(el => el.remove());
        delete block.dataset.imageLoading;
    });
}

function clearAllResultImagesCacheAndUrls() {
    // Invalidate in-flight downloads and disconnect observers.
    const loraNames = new Set([
        ...Object.keys(targetFolderImageCache || {}),
        ...Object.keys(loadedTargetFolderImagePaths || {})
    ]);

    loraNames.forEach(name => {
        if (typeof targetFolderLoadGeneration === 'object' && targetFolderLoadGeneration) {
            targetFolderLoadGeneration[name] = (targetFolderLoadGeneration[name] || 0) + 1;
        }

        if (typeof disconnectTargetFolderLazyObserver === 'function') {
            disconnectTargetFolderLazyObserver(name);
        }
    });

    // NOTE: Do NOT clear the shared download queue/map here.
    // LoRA card previews and result images share the same queue now.

    Object.values(targetFolderImageCache).forEach(imagesMap => {
        if (!imagesMap || typeof imagesMap !== 'object') {
            return;
        }
        Object.values(imagesMap).forEach(entry => {
            if (entry?.objectUrl) {
                try {
                    URL.revokeObjectURL(entry.objectUrl);
                } catch (_) {
                }
            }
        });
    });

    Object.keys(targetFolderImageCache).forEach(key => delete targetFolderImageCache[key]);

    Object.keys(loadedTargetFolderImagePaths).forEach(key => {
        const set = loadedTargetFolderImagePaths[key];
        if (set && typeof set.clear === 'function') {
            set.clear();
        }
        delete loadedTargetFolderImagePaths[key];
    });

    const container = document.getElementById('targetFolderImages');
    if (container) {
        container.innerHTML = '<div class="target-folder-empty">Loading...</div>';
        delete container.dataset.loraName;
    }
}

function ensureLoraCardLoadingOverlay(block) {
    if (!block) {
        return null;
    }

    let overlay = block.querySelector('.lora-loading-overlay');
    if (overlay) {
        return overlay;
    }

    overlay = document.createElement('div');
    overlay.className = 'lora-loading-overlay';
    overlay.innerHTML = '<div class="mini-spinner"></div>';
    block.appendChild(overlay);
    return overlay;
}

function setLoraCardLoadingOverlayState(block, state) {
    if (!block) {
        return;
    }

    const overlay = ensureLoraCardLoadingOverlay(block);
    if (!overlay) {
        return;
    }

    const safeState = String(state || '').toLowerCase();
    const text = safeState === 'queued'
        ? 'Queue'
        : safeState === 'loading'
            ? 'Loading'
            : '';

    overlay.dataset.state = safeState;
    overlay.innerHTML = text
        ? `<div class="mini-spinner"></div><div class="loading-text">${text}</div>`
        : '<div class="mini-spinner"></div>';
}

searchBtn.addEventListener('click', searchLoRAFiles);
if (sortLoraBtn) {
    sortLoraBtn.addEventListener('click', () => {
        loraCardSortOrder = loraCardSortOrder === 'asc' ? 'desc' : 'asc';
        updateLoraSortButtonText();
        displayGallery(getSortedLoraList(currentLoraList));
    });
}
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
    currentLoraList = [];
    clearLoraCardPreviewImagesAndCache();
    if (sortLoraBtn) {
        sortLoraBtn.style.display = 'none';
    }

    // Show loading state
    results.classList.add('show');
    loading.style.display = 'block';
    searchBtn.disabled = true;

    try {
        const loraList = await fetchLoRAFiles(token);
        
        if (loraList.length === 0) {
            showError('No LoRA files found in the lora folder.');
        } else {
            currentLoraList = Array.isArray(loraList) ? loraList : [];
            updateLoraSortButtonText();
            if (sortLoraBtn) {
                sortLoraBtn.style.display = 'inline-flex';
            }
            displayGallery(getSortedLoraList(currentLoraList));
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

function getLoraTimestampMs(lora) {
    const value = lora?.latestTimestampMs;
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }
    return 0;
}

function compareLoraByTime(a, b) {
    const ta = getLoraTimestampMs(a);
    const tb = getLoraTimestampMs(b);
    if (ta !== tb) {
        return ta - tb;
    }
    return String(a?.name || '').localeCompare(String(b?.name || ''), undefined, { sensitivity: 'base' });
}

function getSortedLoraList(list) {
    const copy = Array.isArray(list) ? [...list] : [];
    copy.sort(compareLoraByTime);
    if (loraCardSortOrder === 'desc') {
        copy.reverse();
    }
    return copy;
}

function updateLoraSortButtonText() {
    if (!sortLoraBtn) {
        return;
    }

    // desc = newest first
    sortLoraBtn.textContent = loraCardSortOrder === 'asc'
        ? 'Sort: Oldest'
        : 'Sort: Newest';
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

    // Disconnect previous observer if exists
    if (window.loraCardObserver) {
        window.loraCardObserver.disconnect();
    }

    // Create IntersectionObserver for lazy loading
    const observerOptions = {
        root: null,
        rootMargin: '200px',
        threshold: 0.01
    };

    window.loraCardObserver = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                const block = entry.target;
                const shortcutUrl = block.dataset.shortcutUrl;
                const originalUrl = block.dataset.originalUrl;
                const loraName = block.dataset.loraName;

                if (shortcutUrl && !block.dataset.imageLoading) {
                    block.dataset.imageLoading = 'true';
                    loadLoraCardImage(block, { shortcutUrl, originalUrl, loraName });
                    window.loraCardObserver.unobserve(block);
                }
            }
        });
    }, observerOptions);

    loraList.forEach(lora => {
        const block = document.createElement('div');
        block.className = 'lora-block';
        block.dataset.loraName = lora.name;

        const actions = document.createElement('div');
        actions.className = 'lora-card-actions';
        const hideBtn = document.createElement('button');
        hideBtn.type = 'button';
        hideBtn.className = 'lora-hide-btn';
        hideBtn.textContent = '🗑';
        hideBtn.title = 'Remove this LoRA';
        hideBtn.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            void hideLoraFromMainGallery({ loraName: lora.name, block, button: hideBtn });
        });
        actions.appendChild(hideBtn);
        block.appendChild(actions);

        const overlay = document.createElement('div');
        overlay.className = 'lora-loading-overlay';
        overlay.innerHTML = '<div class="mini-spinner"></div>';

        const nameOverlay = document.createElement('div');
        nameOverlay.className = 'lora-name-overlay';
        nameOverlay.textContent = lora.name;

        block.appendChild(nameOverlay);

        // For LoRA cards: prefer short_cut/{loraName}.jpg to avoid loading huge PNGs.
        // If shortcut is missing, we may generate/upload it from the original LoRA PNG.
        const shortcutPath = `short_cut/${lora.name}.jpg`;
        const shortcutUrl = getFileUrl(shortcutPath);
        block.dataset.shortcutUrl = shortcutUrl;
        if (lora.image?.path) {
            block.dataset.originalUrl = getFileUrl(lora.image.path);
        } else {
            block.dataset.originalUrl = '';
        }

        block.appendChild(overlay);
        // Start observing this block for lazy loading
        window.loraCardObserver.observe(block);
        
        block.addEventListener('click', () => openDetailView(lora.name));
        gallery.appendChild(block);
    });
}

async function resizeImageBlobToMaxSide(blob, maxSidePx = 512, options = {}) {
    const safeMax = Number(maxSidePx);
    const targetMax = Number.isFinite(safeMax) && safeMax > 0 ? safeMax : 512;
    const mimeType = String(options.mimeType || 'image/jpeg');
    const quality = typeof options.quality === 'number' ? options.quality : 0.86;

    if (!blob) {
        throw new Error('Missing blob for resize');
    }

    let bitmap = null;
    try {
        if (typeof createImageBitmap === 'function') {
            bitmap = await createImageBitmap(blob);
        }
    } catch (_) {
        bitmap = null;
    }

    if (!bitmap) {
        // Fallback to HTMLImageElement
        const tempUrl = URL.createObjectURL(blob);
        try {
            await waitForImageReady(tempUrl, 30000);
            const img = new Image();
            img.decoding = 'async';
            img.src = tempUrl;
            await new Promise((resolve, reject) => {
                img.onload = () => resolve();
                img.onerror = () => reject(new Error('Image failed to load for resize'));
            });
            bitmap = { width: img.naturalWidth || img.width, height: img.naturalHeight || img.height, _img: img };
        } finally {
            try {
                URL.revokeObjectURL(tempUrl);
            } catch (_) {
            }
        }
    }

    const srcW = Number(bitmap.width || 0);
    const srcH = Number(bitmap.height || 0);
    if (!(srcW > 0 && srcH > 0)) {
        if (bitmap && typeof bitmap.close === 'function') {
            try {
                bitmap.close();
            } catch (_) {
            }
        }
        throw new Error('Invalid source image size');
    }

    const maxSide = Math.max(srcW, srcH);
    const scale = maxSide > targetMax ? (targetMax / maxSide) : 1;
    const dstW = Math.max(1, Math.round(srcW * scale));
    const dstH = Math.max(1, Math.round(srcH * scale));

    const canvas = document.createElement('canvas');
    canvas.width = dstW;
    canvas.height = dstH;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) {
        if (bitmap && typeof bitmap.close === 'function') {
            try {
                bitmap.close();
            } catch (_) {
            }
        }
        throw new Error('Canvas 2D context unavailable');
    }

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    if (bitmap._img) {
        ctx.drawImage(bitmap._img, 0, 0, dstW, dstH);
    } else {
        ctx.drawImage(bitmap, 0, 0, dstW, dstH);
    }

    if (bitmap && typeof bitmap.close === 'function') {
        try {
            bitmap.close();
        } catch (_) {
        }
    }

    const outBlob = await new Promise((resolve) => {
        canvas.toBlob(
            (result) => resolve(result || null),
            mimeType,
            quality
        );
    });

    if (!outBlob) {
        throw new Error('Failed to encode resized image');
    }
    return outBlob;
}

async function uploadLoraCardShortcutJpg({ loraName, token, blob, onCooldownTick, onUploadStart }) {
    const safeName = String(loraName || '').trim();
    const safeToken = String(token || '').trim();
    if (!safeName) {
        throw new Error('Missing loraName for shortcut upload');
    }
    if (!safeToken) {
        throw new Error('Missing token for shortcut upload');
    }
    if (!blob) {
        throw new Error('Missing blob for shortcut upload');
    }

    const repoId = 'Gazai-ai/Gacha-LoRA';
    const hub = await getHfHubModule();
    const repo = { type: 'model', name: repoId };
    const path = `short_cut/${safeName}.jpg`;

    await enqueueHfUploadFiles({
        hub,
        repo,
        accessToken: safeToken,
        files: [{ path, content: blob }],
        commitTitle: `Add short_cut preview for ${sanitizeSceneName(safeName)}`,
        onCooldownTick,
        onUploadStart
    });
}

function setMainStatus(message, type) {
    if (type === 'error') {
        errorMessage.innerHTML = `<div class="error">✗ ${escapeHtml(message)}</div>`;
        return;
    }
    successMessage.innerHTML = `<div class="success">✓ ${escapeHtml(message)}</div>`;
}

function removeLoraFromMainLists(loraName) {
    const safeName = String(loraName || '').trim();
    if (!safeName) {
        return;
    }

    // Remove from data used by detail view.
    if (allLoRAData && allLoRAData[safeName]) {
        delete allLoRAData[safeName];
    }

    // Remove from current list.
    if (Array.isArray(currentLoraList)) {
        currentLoraList = currentLoraList.filter(item => String(item?.name || '').trim() !== safeName);
    }

    // Release cached preview image URL if any.
    const entry = loraCardImageCache?.[safeName] || null;
    if (entry?.objectUrl) {
        try {
            URL.revokeObjectURL(entry.objectUrl);
        } catch (_) {
        }
    }
    if (loraCardImageCache && safeName in loraCardImageCache) {
        delete loraCardImageCache[safeName];
    }
}

async function hideLoraFromMainGallery({ loraName, block, button }) {
    const safeName = String(loraName || '').trim();
    if (!safeName) {
        return;
    }

    errorMessage.innerHTML = '';
    successMessage.innerHTML = '';

    let token = resolvedHfToken;
    if (!token) {
        try {
            token = await resolveTokenForSearch();
        } catch (error) {
            setMainStatus(error.message || 'Unable to obtain Hugging Face token.', 'error');
            return;
        }
    }

    if (button) {
        button.disabled = true;
        button.textContent = '…';
    }
    if (block) {
        block.classList.add('is-hiding');
    }

    try {
        if (typeof hideLoraModelInHfHiddenJson !== 'function') {
            throw new Error('hideLoraModelInHfHiddenJson() is not available.');
        }

        await hideLoraModelInHfHiddenJson({ loraName: safeName, token });
        removeLoraFromMainLists(safeName);

        if (Array.isArray(currentLoraList) && currentLoraList.length > 0) {
            displayGallery(getSortedLoraList(currentLoraList));
        } else {
            gallery.innerHTML = '';
            galleryContainer.style.display = 'none';
        }

        setMainStatus(`已移除：${safeName}`, 'success');
    } catch (error) {
        console.error('Hide LoRA failed:', error);
        const msg = String(error?.message || error);
        setMainStatus(`移除失敗：${safeName}（${msg}）`, 'error');

        if (button) {
            button.disabled = false;
            button.textContent = '🗑';
        }
        if (block) {
            block.classList.remove('is-hiding');
        }
    }
}

function loadLoraCardImage(block, { shortcutUrl, originalUrl, loraName }) {
    const nameOverlay = block.querySelector('.lora-name-overlay');
    const overlay = block.querySelector('.lora-loading-overlay');

    if (!nameOverlay) {
        return;
    }

    const cached = loraCardImageCache[loraName] || null;
    if (cached && cached.status === 'loaded' && cached.objectUrl) {
        const img = document.createElement('img');
        img.className = 'lora-image';
        img.alt = loraName;
        img.loading = 'lazy';
        img.decoding = 'async';
        img.src = cached.objectUrl;
        block.insertBefore(img, nameOverlay);
        if (overlay && overlay.parentNode === block) {
            overlay.remove();
        }
        return;
    }

    // If the previous attempt failed, allow retry after a short cooldown.
    const now = Date.now();
    const retryCooldownMs = 10_000;
    if (cached && cached.status === 'error') {
        const lastErrorAt = Number(cached.errorAt || cached.loadedAt || 0);
        if (Number.isFinite(lastErrorAt) && lastErrorAt > 0 && (now - lastErrorAt) < retryCooldownMs) {
            if (overlay && overlay.parentNode === block) {
                overlay.remove();
            }
            const fallback = document.createElement('div');
            fallback.className = 'no-image';
            fallback.textContent = 'No preview image';
            block.insertBefore(fallback, nameOverlay);

            // Schedule a retry so the user doesn't have to scroll away/back.
            window.setTimeout(() => {
                if (!document.body.contains(block)) {
                    return;
                }
                delete block.dataset.imageLoading;
                if (window.loraCardObserver) {
                    try {
                        window.loraCardObserver.observe(block);
                    } catch (_) {
                    }
                }
            }, Math.max(0, retryCooldownMs - (now - lastErrorAt)));
            return;
        }
    }

    // If already queued/loading for this LoRA name, don't duplicate. But allow retry if it's stale.
    if (cached && (cached.status === 'queued' || cached.status === 'loading')) {
        setLoraCardLoadingOverlayState(block, cached.status);
        const startedAt = Number(cached.startedAt || 0);
        const staleAfterMs = 15_000;
        if (Number.isFinite(startedAt) && startedAt > 0 && (now - startedAt) < staleAfterMs) {
            return;
        }

        // Stale loading entry: clear and retry.
        delete loraCardImageCache[loraName];
    }

    const safeShortcutUrl = String(shortcutUrl || '').trim();
    const safeOriginalUrl = String(originalUrl || '').trim();

    setLoraCardLoadingOverlayState(block, 'queued');
    loraCardImageCache[loraName] = {
        src: safeShortcutUrl,
        objectUrl: null,
        status: 'queued',
        startedAt: now
    };

    const generation = loraCardLoadGeneration;
    const key = getLoraCardDownloadKey(loraName, safeShortcutUrl);
    const token = resolvedHfToken;
    const headers = token ? { 'Authorization': `Bearer ${token}` } : null;

    const attachObjectUrlToCard = (objectUrlToUse) => {
        if (!block || !document.body.contains(block)) {
            return;
        }

        const nameOverlay = block.querySelector('.lora-name-overlay');
        if (!nameOverlay) {
            return;
        }

        block.querySelectorAll('.no-image').forEach(el => el.remove());
        block.querySelectorAll('img.lora-image').forEach(img => img.remove());

        const overlay = block.querySelector('.lora-loading-overlay');
        const img = document.createElement('img');
        img.className = 'lora-image';
        img.alt = loraName;
        img.loading = 'lazy';
        img.decoding = 'async';
        img.src = objectUrlToUse;
        block.insertBefore(img, nameOverlay);
        if (overlay && overlay.parentNode === block) {
            overlay.remove();
        }
    };

    const showNoPreviewFallback = () => {
        if (!block || !document.body.contains(block)) {
            return;
        }

        const overlay = block.querySelector('.lora-loading-overlay');
        if (overlay && overlay.parentNode === block) {
            overlay.remove();
        }

        const nameOverlay = block.querySelector('.lora-name-overlay');
        if (!nameOverlay) {
            return;
        }

        const fallback = document.createElement('div');
        fallback.className = 'no-image';
        fallback.textContent = 'No preview image';
        block.insertBefore(fallback, nameOverlay);

        delete block.dataset.imageLoading;
        if (window.loraCardObserver) {
            try {
                window.loraCardObserver.observe(block);
            } catch (_) {
            }
        }
    };

    const shouldContinue = () => generation === loraCardLoadGeneration;

    const fallbackToOriginalAndMaybeUpload = () => {
        if (!safeOriginalUrl) {
            loraCardImageCache[loraName] = {
                src: safeShortcutUrl,
                objectUrl: null,
                status: 'error',
                errorAt: Date.now(),
                message: 'Missing original preview image'
            };
            showNoPreviewFallback();
            return;
        }

        const originalKey = getLoraCardDownloadKey(loraName, safeOriginalUrl);
        void enqueueUrlImageDownload({
            key: originalKey,
            url: safeOriginalUrl,
            headers,
            shouldContinue,
            onStarted: () => {
                const entry = loraCardImageCache[loraName] || null;
                if (entry && (entry.status === 'queued' || entry.status === 'loading')) {
                    entry.status = 'loading';
                    entry.loadingAt = Date.now();
                    entry.src = safeOriginalUrl;
                }
                if (block && document.body.contains(block)) {
                    setLoraCardLoadingOverlayState(block, 'loading');
                }
            },
            onLoaded: ({ blob, objectUrl: downloadedObjectUrl }) => {
                // Immediately revoke the large original download URL once we have the blob.
                if (downloadedObjectUrl) {
                    try {
                        URL.revokeObjectURL(downloadedObjectUrl);
                    } catch (_) {
                    }
                }

                (async () => {
                    try {
                        if (!shouldContinue()) {
                            return;
                        }

                        const resizedBlob = await resizeImageBlobToMaxSide(blob, 512, {
                            mimeType: 'image/jpeg',
                            quality: 0.86
                        });

                        if (!shouldContinue()) {
                            return;
                        }

                        const resizedObjectUrl = URL.createObjectURL(resizedBlob);
                        // Replace any previous URL for this LoRA.
                        const prev = loraCardImageCache[loraName] || null;
                        if (prev?.objectUrl && prev.objectUrl !== resizedObjectUrl) {
                            try {
                                URL.revokeObjectURL(prev.objectUrl);
                            } catch (_) {
                            }
                        }

                        loraCardImageCache[loraName] = {
                            src: safeShortcutUrl,
                            objectUrl: resizedObjectUrl,
                            status: 'loaded',
                            loadedAt: Date.now(),
                            generatedFrom: safeOriginalUrl
                        };

                        attachObjectUrlToCard(resizedObjectUrl);

                        // Best-effort upload so future sessions can load the small JPG.
                        if (token) {
                            try {
                                await uploadLoraCardShortcutJpg({
                                    loraName,
                                    token,
                                    blob: resizedBlob,
                                    onCooldownTick: ({ remainingSeconds }) => {
                                        if (block && document.body.contains(block)) {
                                            const overlay = ensureLoraCardLoadingOverlay(block);
                                            if (overlay) {
                                                overlay.dataset.state = 'cooldown';
                                                overlay.innerHTML = `<div class="mini-spinner"></div><div class="loading-text">Wait ${remainingSeconds}s</div>`;
                                            }
                                        }
                                    },
                                    onUploadStart: () => {
                                        if (block && document.body.contains(block)) {
                                            const overlay = ensureLoraCardLoadingOverlay(block);
                                            if (overlay) {
                                                overlay.dataset.state = 'uploading';
                                                overlay.innerHTML = '<div class="mini-spinner"></div><div class="loading-text">Uploading</div>';
                                            }
                                        }
                                    }
                                });
                            } catch (uploadError) {
                                console.warn(`Failed to upload short_cut preview for ${loraName}:`, uploadError?.message || uploadError);
                            } finally {
                                if (block && document.body.contains(block)) {
                                    const overlay = block.querySelector('.lora-loading-overlay');
                                    if (overlay && overlay.parentNode === block) {
                                        overlay.remove();
                                    }
                                }
                            }
                        }
                    } catch (processError) {
                        loraCardImageCache[loraName] = {
                            src: safeOriginalUrl,
                            objectUrl: null,
                            status: 'error',
                            errorAt: Date.now(),
                            message: String(processError?.message || processError)
                        };
                        showNoPreviewFallback();
                    }
                })();
            },
            onError: (error) => {
                loraCardImageCache[loraName] = {
                    src: safeOriginalUrl,
                    objectUrl: null,
                    status: 'error',
                    errorAt: Date.now(),
                    message: String(error?.message || error)
                };
                showNoPreviewFallback();
            }
        }).catch(() => {});
    };

    void enqueueUrlImageDownload({
        key,
        url: safeShortcutUrl,
        headers,
        shouldContinue,
        onStarted: () => {
            const entry = loraCardImageCache[loraName] || null;
            if (entry && (entry.status === 'queued' || entry.status === 'loading')) {
                entry.status = 'loading';
                entry.loadingAt = Date.now();
            }
            if (block && document.body.contains(block)) {
                setLoraCardLoadingOverlayState(block, 'loading');
            }
        },
        onLoaded: ({ objectUrl }) => {
            loraCardImageCache[loraName] = {
                src: safeShortcutUrl,
                objectUrl,
                status: 'loaded',
                loadedAt: Date.now()
            };

            attachObjectUrlToCard(objectUrl);
        },
        onError: (error) => {
            const msg = String(error?.message || error);
            const isNotFound = /\bHTTP\s*404\b/i.test(msg);
            if (isNotFound) {
                // Shortcut doesn't exist yet: build it from original.
                fallbackToOriginalAndMaybeUpload();
                return;
            }

            loraCardImageCache[loraName] = {
                src: safeShortcutUrl,
                objectUrl: null,
                status: 'error',
                errorAt: Date.now(),
                message: msg
            };
            showNoPreviewFallback();
        }
    }).catch(() => {});
}

function openDetailView(loraName) {
    // Requirement: entering any LoRA card clears all preview images.
    if (window.loraCardObserver) {
        try {
            window.loraCardObserver.disconnect();
        } catch (_) {
        }
    }
    clearLoraCardPreviewImagesAndCache();

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
            const imgPathAttr = escapeHtml(String(item.path || ''));
            const status = item.status || (item.objectUrl ? 'loaded' : 'loading');

            if (status === 'loaded' && item.objectUrl) {
                return `<div class="target-folder-item" data-img-key="${domKey}" data-img-path="${imgPathAttr}"><img src="${item.objectUrl}" alt="${escapeHtml(item.fileName)}" loading="lazy" decoding="async"></div>`;
            }

            if (status === 'error') {
                return `<div class="target-folder-item" data-img-key="${domKey}" data-img-path="${imgPathAttr}"><div class="target-folder-loading is-error">Load failed</div></div>`;
            }

            return `<div class="target-folder-item" data-img-key="${domKey}" data-img-path="${imgPathAttr}"><div class="target-folder-loading"><div class="mini-spinner"></div><div class="loading-text">Loading...</div></div></div>`;
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
        const path = clickedTile.dataset.imgPath || '';

        console.log('[zoom] open lightbox for:', clickedImage ? clickedImage.src : '(loading)');
        openImageLightbox({
            src: clickedImage ? clickedImage.src : '',
            altText: clickedImage ? clickedImage.alt || '' : '',
            loraName,
            domKey,
            path
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

function requestTargetFolderImageIfNeeded(loraName, imageItem) {
    if (!imageItem || imageItem.status === 'loaded' || imageItem.src) {
        return;
    }

    const path = String(imageItem.path || '').trim();
    if (!path) {
        return;
    }

    const token = resolvedHfToken;
    if (!token) {
        return;
    }

    const repoId = 'Gazai-ai/Gacha-LoRA';
    const generation = (typeof targetFolderLoadGeneration === 'object' && targetFolderLoadGeneration)
        ? (targetFolderLoadGeneration[loraName] || 0)
        : 0;

    if (typeof enqueueTargetFolderImageDownload !== 'function') {
        return;
    }

    void enqueueTargetFolderImageDownload({
        loraName,
        path,
        token,
        repoId,
        generation
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
            domKey: item.domKey || makeImageDomKey(item.path),
            path: item.path || ''
        }));
    }

    const tiles = document.querySelectorAll('#targetFolderImages .target-folder-item');
    return Array.from(tiles).map(tile => {
        const img = tile.querySelector('img');
        return {
            src: img ? img.src : '',
            alt: img ? img.alt || '' : '',
            status: img ? 'loaded' : 'loading',
            domKey: tile.dataset.imgKey || '',
            path: tile.dataset.imgPath || ''
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

function openImageLightbox({ src, altText, loraName, domKey, path }) {
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
            domKey: domKey || '',
            path: path || ''
        });
        index = 0;
    }

    lightboxState = {
        images,
        index
    };

    requestTargetFolderImageIfNeeded(loraName, lightboxState.images[lightboxState.index]);
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

    const active = lightboxState.images[lightboxState.index];
    requestTargetFolderImageIfNeeded(
        (document.getElementById('targetFolderImages')?.dataset?.loraName || '').trim(),
        active
    );

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

    requestTargetFolderImageIfNeeded(
        (document.getElementById('targetFolderImages')?.dataset?.loraName || '').trim(),
        activeImage
    );

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

    const total = lightboxState.images.length;
    const currentIndex = Math.min(Math.max(0, Number(lightboxState.index) || 0), Math.max(0, total - 1));
    const maxSide = 3;
    const startIndex = Math.max(0, currentIndex - maxSide);
    const endIndex = Math.min(total - 1, currentIndex + maxSide);
    const visibleIndices = [];
    for (let i = startIndex; i <= endIndex; i += 1) {
        visibleIndices.push(i);
    }

    thumbContainer.innerHTML = visibleIndices
        .map((idx) => {
            const item = lightboxState.images[idx];
            const isActive = idx === currentIndex ? 'is-active' : '';
            const isLoading = !item?.src || item?.status !== 'loaded';
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
        tile.innerHTML = `<img src="${entry.objectUrl}" alt="${escapeHtml(entry.fileName)}" loading="lazy" decoding="async">`;
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
        domKey,
        path: entry.path || ''
    };

    if (matchIndex === lightboxState.index) {
        updateLightboxMainDisplay();
    }

    renderLightboxThumbnails();
}

function backToMainView() {
    mainView.style.display = 'block';
    detailView.classList.remove('active');

    // Requirement: leaving detail clears all result images.
    clearAllResultImagesCacheAndUrls();

    // Rebuild the gallery so the observer is reattached and images can lazy-load again.
    if (Array.isArray(currentLoraList) && currentLoraList.length > 0) {
        displayGallery(getSortedLoraList(currentLoraList));
    }
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
