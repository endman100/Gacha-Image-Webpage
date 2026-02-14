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

        let allLoRAData = {}; // 存儲所有 LoRA 的數據
        let privateTokenData = null;
        let workflowData = null;
        let resolvedHfToken = '';
        const loadedTargetFolderImagePaths = {};
        const targetFolderImageCache = {};
        const targetFolderSortOrder = {};
        const loraFeatureCache = {};

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
                throw new Error('瀏覽器不支援 Web Crypto，無法解密內建 token');
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
                throw new Error('請輸入解密密碼');
            }

            try {
                const decryptedToken = await decryptEmbeddedHfToken(password);
                if (!decryptedToken) {
                    throw new Error('解密後 token 為空');
                }
                resolvedHfToken = decryptedToken;
                return decryptedToken;
            } catch (_) {
                throw new Error('解密失敗：密碼錯誤或資料無法解密');
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

            // 驗證 token
            if (!token) {
                showError('無法取得 Hugging Face Token');
                return;
            }

            // 清空以前的結果
            gallery.innerHTML = '';
            errorMessage.innerHTML = '';
            successMessage.innerHTML = '';
            galleryContainer.style.display = 'none';
            allLoRAData = {};

            // 顯示加載狀態
            results.classList.add('show');
            loading.style.display = 'block';
            searchBtn.disabled = true;

            try {
                const loraList = await fetchLoRAFiles(token);
                
                if (loraList.length === 0) {
                    showError('在 lora 資料夾中找不到任何 LoRA 檔案');
                } else {
                    displayGallery(loraList);
                    successMessage.innerHTML = '<div class="success">✓ 成功找到 LoRA 模型！</div>';
                }
            } catch (error) {
                console.error('錯誤:', error);
                showError(error.message);
            } finally {
                loading.style.display = 'none';
                searchBtn.disabled = false;
            }
        }

        async function fetchLoRAFiles(token) {
            const repo = 'Gazai-ai/Gacha-LoRA';

            try {
                await fetchAndLogPrivateTokenFile(repo, token);
                await fetchWorkflowJsonFile(repo, token);

                // 訪問 lora 資料夾內的檔案
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
                        throw new Error('Token 無效或已過期');
                    } else if (response.status === 404) {
                        throw new Error('找不到倉庫或 lora 資料夾');
                    } else {
                        throw new Error(`API 錯誤: ${response.status}`);
                    }
                }

                const data = await response.json();
                
                // 按 LoRA 名稱分組文件
                const loraGrouped = {};
                
                if (Array.isArray(data)) {
                    data.forEach(item => {
                        if (item.type === 'file' && item.path) {
                            const fileName = item.path.split('/').pop();
                            // 提取 LoRA 名稱（去掉擴展名和版本號）
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
                            
                            // 尋找圖片
                            if (/\.(png|jpg|jpeg|webp)$/i.test(fileName)) {
                                loraGrouped[loraName].image = item;
                            }
                            
                            // 尋找 safetensors 檔案
                            if (fileName.endsWith('.safetensors')) {
                                loraGrouped[loraName].safetensors = item;
                            }
                        }
                    });
                }

                const loraList = Object.values(loraGrouped);
                if (loraList.length === 0) {
                    throw new Error('在 lora 資料夾中找不到任何 LoRA 檔案');
                }

                // 保存數據用於詳細視圖
                allLoRAData = loraGrouped;

                // 只保留有圖片或 safetensors 的 LoRA
                const filteredLoraList = loraList.filter(lora => lora.image || lora.safetensors);
                
                if (filteredLoraList.length === 0) {
                    throw new Error('在 lora 資料夾中找不到任何有效的 LoRA 模型');
                }

                return filteredLoraList.sort((a, b) => a.name.localeCompare(b.name));
                
            } catch (error) {
                throw new Error(`無法獲取檔案列表: ${error.message}`);
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
                    console.warn(`讀取 private token 檔案失敗 (HTTP ${response.status})`);
                    return;
                }

                const text = await response.text();
                const jsonData = JSON.parse(text);
                privateTokenData = jsonData;
                console.log('private token JSON:', jsonData);
            } catch (error) {
                console.warn('private token 檔案不是有效 JSON 或讀取失敗:', error.message);
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
                    console.warn(`讀取 workflow.json 失敗 (HTTP ${response.status})`);
                    return;
                }

                const text = await response.text();
                workflowData = JSON.parse(text);
                console.log('workflow.json JSON:', workflowData);
            } catch (error) {
                console.warn('workflow.json 不是有效 JSON 或讀取失敗:', error.message);
            }
        }

        function extractLoRAName(fileName) {
            // 移除擴展名
            let name = fileName.replace(/\.[^.]+$/, '');
            // 按 "_" 或 "-" 分割，取第一部分
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
                    imageHtml = `<div class="no-image">無預覽圖片</div>`;
                }

                block.innerHTML = `
                    ${imageHtml}
                    <div class="lora-name-overlay">${escapeHtml(lora.name)}</div>
                `;
                
                block.addEventListener('click', () => openDetailView(lora.name));
                gallery.appendChild(block);
            });
        }

        function getFileUrl(path) {
            // 構建 Hugging Face 檔案 URL
            return `https://huggingface.co/Gazai-ai/Gacha-LoRA/resolve/main/${path}`;
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
            
            // 第一行：圖片、Group名稱與JSON信息
            let html = '<div class="detail-row">';
            html += '<h3>📋 模型信息</h3>';
            html += '<div class="image-json-container">';
            
            // 圖片部分
            if (loraData.image) {
                const imageUrl = getFileUrl(loraData.image.path);
                html += `<img src="${imageUrl}" alt="${escapeHtml(loraName)}" class="preview-image">`;
            } else {
                html += '<div class="preview-image" style="background: #f0f0f0; display: flex; align-items: center; justify-content: center;">無預覽圖片</div>';
            }
            
            html += '<div class="json-info"><pre id="jsonContent">載入 JSON 內容中...</pre></div></div></div>';
            
            // 第二行：Workflow 設置
            html += '<div class="detail-row">';
            html += '<h3>⚙️ Workflow 設置</h3>';
            html += '<div class="upload-container">';
            html += '<div class="upload-input-group">';
            html += '<label for="uploadTimes">生成次數:</label>';
            html += '<input type="number" id="uploadTimes" min="1" max="100" value="1">';
            html += '</div>';
            html += '<button class="upload-btn" id="runpodBtn">生成 Gacha</button>';
            html += '</div>';
            html += '<div id="runpodStatus" class="upload-status"></div>';
            html += '</div>';

            // 第三行：結果圖片
            html += '<div class="detail-row">';
            html += '<h3>🖼️ 結果圖片</h3>';
            html += `<div class="target-folder-section">`;
            html += '<div class="target-folder-toolbar">';
            html += `<div class="target-folder-title">結果圖片：/image/${escapeHtml(loraName)}</div>`;
            html += `<button id="sortImagesBtn" class="sort-btn">排序：${targetFolderSortOrder[loraName] === 'asc' ? '升序' : '降序'}</button>`;
            html += '</div>';
            html += '<div id="targetFolderImages" class="target-folder-images"><div class="target-folder-empty">載入中...</div></div>';
            html += '</div>';
            html += '</div>';
            
            detailContent.innerHTML = html;
            
            document.getElementById('runpodBtn').addEventListener('click', () => runWorkflowWithRunpod(loraName));
            document.getElementById('sortImagesBtn').addEventListener('click', () => {
                targetFolderSortOrder[loraName] = targetFolderSortOrder[loraName] === 'asc' ? 'desc' : 'asc';
                updateSortButtonText(loraName);
                renderTargetFolderImages(loraName);
            });

            updateSortButtonText(loraName);

            loadDetailJsonAndTargetImages(loraName, loraData);
        }

        function updateSortButtonText(loraName) {
            const sortBtn = document.getElementById('sortImagesBtn');
            if (!sortBtn) {
                return;
            }

            sortBtn.textContent = `排序：${targetFolderSortOrder[loraName] === 'asc' ? '升序' : '降序'}`;
        }

        function compareImageName(a, b) {
            return a.fileName.localeCompare(b.fileName, undefined, { numeric: true, sensitivity: 'base' });
        }

        function renderTargetFolderImages(loraName) {
            const container = document.getElementById('targetFolderImages');
            if (!container) {
                return;
            }

            const imagesMap = targetFolderImageCache[loraName] || {};
            const imageList = Object.values(imagesMap);

            if (imageList.length === 0) {
                container.innerHTML = '<div class="target-folder-empty">目前目標資料夾沒有圖片</div>';
                return;
            }

            imageList.sort(compareImageName);
            if (targetFolderSortOrder[loraName] === 'desc') {
                imageList.reverse();
            }

            container.innerHTML = imageList
                .map(item => `<div class="target-folder-item"><img src="${item.objectUrl}" alt="${escapeHtml(item.fileName)}"></div>`)
                .join('');
        }

        async function runWorkflowWithRunpod(loraName) {
            const runpodBtn = document.getElementById('runpodBtn');

            if (!privateTokenData || !privateTokenData.runpod) {
                showRunpodStatus('找不到 private token 的 runpod 欄位', 'error');
                return;
            }

            if (!workflowData) {
                showRunpodStatus('找不到 workflow.json 內容，請先重新搜尋 LoRA', 'error');
                return;
            }

            const times = parseInt(document.getElementById('uploadTimes').value, 10);
            if (!times || times < 1) {
                showRunpodStatus('請輸入有效的執行次數', 'error');
                return;
            }

            runpodBtn.disabled = true;
            showRunpodStatus(`準備執行 ${times} 次 Workflow...`, 'loading');

            try {
                const endpointId = 'vvknohtwuum3te';
                const runpodToken = privateTokenData.runpod;
                const hfToken = resolvedHfToken;
                const maxThreads = Math.min(5, times);

                if (!hfToken) {
                    throw new Error('找不到 Hugging Face Token，請先重新搜尋 LoRA');
                }

                const repoId = 'Gazai-ai/Gacha-LoRA';
                const uploadPath = `image/${loraName}`;
                const hub = await import('https://esm.sh/@huggingface/hub');
                const repo = { type: 'model', name: repoId };

                let nextRound = 1;
                let runningCount = 0;
                let finishedCount = 0;
                let uploadedCount = 0;
                let failedCount = 0;
                const failedRounds = [];

                function renderProgress(message, type = 'loading') {
                    const waitingCount = Math.max(0, times - finishedCount - runningCount);
                    showRunpodStatus(
                        `${message}｜進度 ${finishedCount}/${times}（成功 ${uploadedCount}，失敗 ${failedCount}，進行中 ${runningCount}，等待 ${waitingCount}）`,
                        type
                    );
                }

                async function runSingleRound(round) {
                    renderProgress(`第 ${round}/${times} 次：送出 Runpod 任務...`);
                    const normalizedWorkflowInput = buildRunpodWorkflowInput(workflowData);
                    const features = await getCharacterFeaturesForLora(loraName);
                    const promptAdjustedWorkflowInput = applyCheckpointAndPromptOverrides(normalizedWorkflowInput, features);
                    const overrideWorkflowInput = applyLoraNameOverridesForTitles(promptAdjustedWorkflowInput, loraName);
                    const seededWorkflowInput = applyRandomSeedsForSeedTitle(overrideWorkflowInput);
                    const sanitizedWorkflowInput = normalizeWorkflowLoraNames(seededWorkflowInput);
                    logWorkflowNodeModificationReport(normalizedWorkflowInput, sanitizedWorkflowInput);
                    
                    const dataToSend = {
                        input: {
                            ...sanitizedWorkflowInput,
                            // return_format: 'base64'
                        }
                    };
                    console.log('Runpod input payload preview:', sanitizedWorkflowInput);

                    const runResponse = await fetch(`https://api.runpod.ai/v2/${endpointId}/run`, {
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${runpodToken}`,
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify(dataToSend)
                    });

                    if (!runResponse.ok) {
                        const errorText = await runResponse.text();
                        throw new Error(`Runpod 啟動失敗 (HTTP ${runResponse.status}): ${errorText}`);
                    }

                    const runData = await runResponse.json();
                    const jobId = runData.id;

                    if (!jobId) {
                        throw new Error('Runpod 回應缺少 job id');
                    }

                    renderProgress(`第 ${round}/${times} 次：Runpod 任務執行中 (${jobId})`);

                    const output = await pollRunpodResult(endpointId, jobId, runpodToken);
                    const imageSrc = extractLastGeneratedImage(output);
                    console.log(`第 ${round}/${times} 次 Runpod 輸出結果:`, output, '提取的圖片 URL:', imageSrc);

                    if (!imageSrc) {
                        throw new Error(`第 ${round}/${times} 次：任務完成，但找不到最後生成圖片`);
                    }

                    const imageBlob = await fetchGeneratedImageBlob(imageSrc);
                    const extension = detectImageExtension(imageBlob.type, imageSrc);
                    const fileName = `${loraName}-${Date.now()}-${round}.${extension}`;

                    await hub.uploadFiles({
                        repo,
                        accessToken: hfToken,
                        files: [
                            {
                                path: `${uploadPath}/${fileName}`,
                                content: imageBlob
                            }
                        ],
                        commitTitle: `Upload workflow result ${round}/${times} for ${loraName}`
                    });

                    uploadedCount += 1;
                    renderProgress(`第 ${round}/${times} 次完成，已上傳 ${uploadedCount}/${times} 張到 /${uploadPath}`);

                    await loadTargetFolderImages(loraName, hfToken, { reset: false });
                }

                async function worker() {
                    while (true) {
                        const round = nextRound;
                        if (round > times) {
                            return;
                        }
                        nextRound += 1;
                        runningCount += 1;
                        renderProgress(`第 ${round}/${times} 次：已加入執行`);

                        try {
                            await runSingleRound(round);
                        } catch (error) {
                            failedCount += 1;
                            failedRounds.push(`第 ${round} 次：${error.message}`);
                            renderProgress(`第 ${round}/${times} 次失敗`);
                        } finally {
                            runningCount -= 1;
                            finishedCount += 1;
                        }
                    }
                }

                renderProgress(`啟動並行執行（最大 ${maxThreads} threads）`);

                await Promise.all(
                    Array.from({ length: maxThreads }, () => worker())
                );

                if (failedCount > 0) {
                    const preview = failedRounds.slice(0, 3).join('；');
                    showRunpodStatus(`✗ Workflow 完成（成功 ${uploadedCount}/${times}，失敗 ${failedCount}）。${preview}`, 'error');
                } else {
                    showRunpodStatus(`✓ Workflow 全部完成，已上傳 ${uploadedCount} 張圖片（共 ${times} 次）`, 'success');
                }
            } catch (error) {
                showRunpodStatus(`✗ Workflow 執行失敗: ${error.message}`, 'error');
            } finally {
                runpodBtn.disabled = false;
            }
        }

        async function fetchGeneratedImageBlob(imageSrc) {
            try {
                const response = await fetch(imageSrc);
                if (!response.ok) {
                    throw new Error(`下載生成圖片失敗 (HTTP ${response.status})`);
                }
                return await response.blob();
            } catch (error) {
                const isCorsLike = error instanceof TypeError
                    || /Failed to fetch|CORS|Access-Control-Allow-Origin/i.test(String(error?.message || ''));

                if (isCorsLike) {
                    throw new Error('下載生成圖片被瀏覽器 CORS 限制擋下（Runpod CloudFront URL 無 Access-Control-Allow-Origin）。請改用 return_format=base64，或使用後端代理下載後再上傳 HF。');
                }

                throw error;
            }
        }

        function detectImageExtension(mimeType, imageSrc) {
            if (mimeType === 'image/jpeg') {
                return 'jpg';
            }
            if (mimeType === 'image/webp') {
                return 'webp';
            }
            if (mimeType === 'image/png') {
                return 'png';
            }

            const srcMatch = typeof imageSrc === 'string'
                ? imageSrc.match(/\.([a-zA-Z0-9]+)(?:\?|$)/)
                : null;

            if (srcMatch && srcMatch[1]) {
                return srcMatch[1].toLowerCase();
            }

            return 'png';
        }

        async function pollRunpodResult(endpointId, jobId, runpodToken) {
            const intervalMs = 2000;
            const timeoutMs = 600000;
            const maxAttempts = Math.ceil(timeoutMs / intervalMs);

            for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                const statusRes = await fetch(`https://api.runpod.ai/v2/${endpointId}/status/${jobId}`, {
                    headers: {
                        'Authorization': `Bearer ${runpodToken}`
                    }
                });

                if (!statusRes.ok) {
                    const err = await statusRes.text();
                    throw new Error(`查詢狀態失敗 (HTTP ${statusRes.status}): ${err}`);
                }

                const statusData = await statusRes.json();
                const status = statusData.status;

                if (status === 'COMPLETED') {
                    return statusData.output;
                }

                if (status === 'FAILED' || status === 'CANCELLED' || status === 'TIMED_OUT') {
                    throw new Error(`Runpod 任務失敗: ${status}`);
                }

                await new Promise(resolve => setTimeout(resolve, intervalMs));
            }

            throw new Error('Runpod 任務等待逾時');
        }

        function buildRunpodWorkflowInput(rawWorkflowData) {
            if (rawWorkflowData && typeof rawWorkflowData === 'object') {
                if (rawWorkflowData.workflow) {
                    return rawWorkflowData;
                }
            }

            return {
                workflow: rawWorkflowData
            };
        }

        function applyLoraNameOverridesForTitles(workflowInput, groupName) {
            const targetLoraName = `AniniLora/GachaCharacterLora/${groupName}-000020.safetensors`;
            let replacedCount = 0;

            function cloneAndApply(value) {
                if (Array.isArray(value)) {
                    return value.map(item => cloneAndApply(item));
                }

                if (value && typeof value === 'object') {
                    const cloned = {};

                    Object.entries(value).forEach(([key, currentValue]) => {
                        cloned[key] = cloneAndApply(currentValue);
                    });

                    const title = cloned?._meta?.title;
                    if ((title === 'load LoRA' || title === 'load LoRA2')
                        && cloned.inputs
                        && typeof cloned.inputs === 'object') {
                        cloned.inputs.lora_name = targetLoraName;
                        replacedCount += 1;
                    }

                    return cloned;
                }

                return value;
            }

            const updated = cloneAndApply(workflowInput);
            console.log(`Runpod workflow target lora_name override count: ${replacedCount}, value: ${targetLoraName}`);
            return updated;
        }

        function applyRandomSeedsForSeedTitle(workflowInput) {
            let replacedCount = 0;

            function cloneAndApply(value) {
                if (Array.isArray(value)) {
                    return value.map(item => cloneAndApply(item));
                }

                if (value && typeof value === 'object') {
                    const cloned = {};

                    Object.entries(value).forEach(([key, currentValue]) => {
                        cloned[key] = cloneAndApply(currentValue);
                    });

                    const title = cloned?._meta?.title;
                    if (title === 'Seed' && cloned.inputs && typeof cloned.inputs === 'object') {
                        cloned.inputs.seed = Math.floor(Math.random() * 65536);
                        replacedCount += 1;
                    }

                    return cloned;
                }

                return value;
            }

            const updated = cloneAndApply(workflowInput);
            console.log(`Runpod workflow random seed override count: ${replacedCount}`);
            return updated;
        }

        function applyCheckpointAndPromptOverrides(workflowInput, features) {
            const checkpointName = 'JANKUTrainedNoobaiRouwei_v50.safetensors';
            const headFeatures = (features?.character_head_features || '').trim();
            const bodyFeatures = (features?.character_body_features || '').trim();
            const fullBodyPrompt = [
                'masterpiece, best quality, highres, 8K, ultra detailed,',
                'GAZAI,',
                '1girl, full body, anime style,',
                headFeatures + ',',
                bodyFeatures + ',',
                'looking at viewer,',
                ',',
                'detailed background, '
            ].join('\n');

            const upperBodyPrompt = [
                'masterpiece, best quality, highres, 8K, ultra detailed,',
                'GAZAI,',
                headFeatures + ',',
                '1girl, upper body, anime style,',
                'looking at viewer,'
            ].join('\n');

            let ckptReplaced = 0;
            let positivePromptReplaced = 0;
            let positivePromptHeadReplaced = 0;

            function cloneAndApply(value) {
                if (Array.isArray(value)) {
                    return value.map(item => cloneAndApply(item));
                }

                if (value && typeof value === 'object') {
                    const cloned = {};
                    Object.entries(value).forEach(([key, currentValue]) => {
                        cloned[key] = cloneAndApply(currentValue);
                    });

                    if (cloned.class_type === 'CheckpointLoaderSimple' && cloned.inputs && typeof cloned.inputs === 'object') {
                        cloned.inputs.ckpt_name = checkpointName;
                        ckptReplaced += 1;
                    }

                    const title = cloned?._meta?.title;
                    if (title === 'positive prompt' && cloned.inputs && typeof cloned.inputs === 'object') {
                        cloned.inputs.text = fullBodyPrompt;
                        positivePromptReplaced += 1;
                    }

                    if (title === 'positive prompt head' && cloned.inputs && typeof cloned.inputs === 'object') {
                        cloned.inputs.text = upperBodyPrompt;
                        positivePromptHeadReplaced += 1;
                    }

                    return cloned;
                }

                return value;
            }

            const updated = cloneAndApply(workflowInput);
            console.log(
                `Runpod workflow overrides -> checkpoint: ${ckptReplaced}, positive prompt: ${positivePromptReplaced}, positive prompt head: ${positivePromptHeadReplaced}`
            );
            return updated;
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
                    character_body_features: ''
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
                    character_body_features: extractFeatureString(parsed, 'character_body_features')
                };
            } catch (error) {
                console.warn(`讀取角色特徵 JSON 失敗 (${loraName}):`, error.message);
                loraFeatureCache[loraName] = {
                    character_head_features: '',
                    character_body_features: ''
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

        function normalizeWorkflowLoraNames(workflowInput) {
            let replacedCount = 0;

            function normalizeValue(value) {
                if (Array.isArray(value)) {
                    return value.map(item => normalizeValue(item));
                }

                if (value && typeof value === 'object') {
                    const normalizedObject = {};

                    Object.entries(value).forEach(([key, currentValue]) => {
                        if (key === 'lora_name' && typeof currentValue === 'string') {
                            const normalizedName = currentValue.replace(/\\/g, '/');
                            if (normalizedName !== currentValue) {
                                replacedCount += 1;
                            }
                            normalizedObject[key] = normalizedName;
                        } else {
                            normalizedObject[key] = normalizeValue(currentValue);
                        }
                    });

                    return normalizedObject;
                }

                return value;
            }

            const normalized = normalizeValue(workflowInput);
            console.log(`Runpod workflow lora_name path normalized count: ${replacedCount}`);
            return normalized;
        }

        function logWorkflowNodeModificationReport(beforeWorkflowInput, afterWorkflowInput) {
            const beforeGraph = unwrapWorkflowGraph(beforeWorkflowInput);
            const afterGraph = unwrapWorkflowGraph(afterWorkflowInput);

            const targets = [
                {
                    label: 'load LoRA',
                    matcher: node => node?._meta?.title === 'load LoRA',
                    getValue: node => node?.inputs?.lora_name
                },
                {
                    label: 'load LoRA2',
                    matcher: node => node?._meta?.title === 'load LoRA2',
                    getValue: node => node?.inputs?.lora_name
                },
                {
                    label: 'positive prompt',
                    matcher: node => node?._meta?.title === 'positive prompt',
                    getValue: node => node?.inputs?.text
                },
                {
                    label: 'positive prompt head',
                    matcher: node => node?._meta?.title === 'positive prompt head',
                    getValue: node => node?.inputs?.text
                },
                {
                    label: 'CheckpointLoaderSimple',
                    matcher: node => node?.class_type === 'CheckpointLoaderSimple',
                    getValue: node => node?.inputs?.ckpt_name
                },
                {
                    label: 'Seed',
                    matcher: node => node?._meta?.title === 'Seed',
                    getValue: node => node?.inputs?.seed
                }
            ];

            console.group('Runpod workflow node modification report');

            targets.forEach(target => {
                const matchedNodeIds = Object.keys(afterGraph).filter(nodeId => target.matcher(afterGraph[nodeId]));

                if (matchedNodeIds.length === 0) {
                    console.warn(`[缺乏node] ${target.label}`);
                    return;
                }

                matchedNodeIds.forEach(nodeId => {
                    const beforeValue = target.getValue(beforeGraph[nodeId]);
                    const afterValue = target.getValue(afterGraph[nodeId]);
                    const isChanged = JSON.stringify(beforeValue) !== JSON.stringify(afterValue);
                    console.log(
                        `[${target.label}] node ${nodeId} | changed=${isChanged} | before=`,
                        beforeValue,
                        '| after=',
                        afterValue
                    );
                });
            });

            console.groupEnd();
        }

        function unwrapWorkflowGraph(workflowInput) {
            if (workflowInput
                && typeof workflowInput === 'object'
                && workflowInput.workflow
                && typeof workflowInput.workflow === 'object'
                && !Array.isArray(workflowInput.workflow)) {
                return workflowInput.workflow;
            }

            if (workflowInput && typeof workflowInput === 'object' && !Array.isArray(workflowInput)) {
                return workflowInput;
            }

            return {};
        }

        function extractLastGeneratedImage(output) {
            if (output && typeof output === 'object') {
                if (Array.isArray(output.message) && output.message.length > 0) {
                    const lastMessage = output.message[output.message.length - 1];
                    if (lastMessage && typeof lastMessage.url === 'string' && /^https?:\/\//i.test(lastMessage.url)) {
                        return lastMessage.url;
                    }
                }

                if (Array.isArray(output.download_files) && output.download_files.length > 0) {
                    const lastDownload = output.download_files[output.download_files.length - 1];
                    if (typeof lastDownload === 'string' && /^https?:\/\//i.test(lastDownload)) {
                        return lastDownload;
                    }
                    if (lastDownload && typeof lastDownload.url === 'string' && /^https?:\/\//i.test(lastDownload.url)) {
                        return lastDownload.url;
                    }
                }
            }

            const candidates = [];

            function walk(value) {
                if (!value) {
                    return;
                }

                if (typeof value === 'string') {
                    if (/^data:image\//i.test(value)) {
                        candidates.push(value);
                        return;
                    }

                    if (/^https?:\/\/.+\.(png|jpg|jpeg|webp)(\?.*)?$/i.test(value)) {
                        candidates.push(value);
                        return;
                    }

                    if (value.length > 1000 && /^[A-Za-z0-9+/=\s]+$/.test(value)) {
                        candidates.push(`data:image/png;base64,${value.replace(/\s/g, '')}`);
                        return;
                    }
                }

                if (Array.isArray(value)) {
                    value.forEach(item => walk(item));
                    return;
                }

                if (typeof value === 'object') {
                    Object.values(value).forEach(v => walk(v));
                }
            }

            walk(output);

            if (candidates.length === 0) {
                return null;
            }

            return candidates[candidates.length - 1];
        }

        function showRunpodStatus(message, type) {
            const runpodStatus = document.getElementById('runpodStatus');
            if (!runpodStatus) {
                return;
            }

            runpodStatus.textContent = message;
            runpodStatus.className = `upload-status show ${type}`;
        }

        async function loadDetailJsonAndTargetImages(loraName, loraData) {
            const token = resolvedHfToken;
            const repoId = 'Gazai-ai/Gacha-LoRA';

            const jsonContent = document.getElementById('jsonContent');
            const jsonFile = loraData.files.find(f => f.path.endsWith('.json'));

            if (!jsonFile) {
                if (jsonContent) {
                    jsonContent.textContent = '無 JSON 文件信息';
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
                        jsonContent.textContent = `載入 JSON 失敗: ${error.message}`;
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
                container.innerHTML = '<div class="target-folder-empty">載入中...</div>';
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
                    container.innerHTML = '<div class="target-folder-empty">目前目標資料夾沒有圖片</div>';
                    return;
                }

                if (!treeRes.ok) {
                    throw new Error(`HTTP ${treeRes.status}`);
                }

                const data = await treeRes.json();
                const imageItems = (Array.isArray(data) ? data : [])
                    .filter(item => item.type === 'file' && /\.(png|jpg|jpeg|webp)$/i.test(item.path));

                if (imageItems.length === 0) {
                    container.innerHTML = '<div class="target-folder-empty">目前目標資料夾沒有圖片</div>';
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

                for (const item of itemsToLoad) {
                    const fileRes = await fetch(`https://huggingface.co/${repoId}/resolve/main/${item.path}`, {
                        headers: {
                            'Authorization': `Bearer ${token}`
                        }
                    });

                    if (!fileRes.ok) {
                        continue;
                    }

                    const blob = await fileRes.blob();
                    const objectUrl = URL.createObjectURL(blob);
                    const name = item.path.split('/').pop() || item.path;
                    targetFolderImageCache[loraName][item.path] = {
                        path: item.path,
                        fileName: name,
                        objectUrl
                    };
                    knownPaths.add(item.path);
                }

                renderTargetFolderImages(loraName);
            } catch (error) {
                container.innerHTML = `<div class="target-folder-empty">載入目標資料夾圖片失敗: ${escapeHtml(error.message)}</div>`;
            }
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
