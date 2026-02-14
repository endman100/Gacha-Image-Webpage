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
        let hfHubModulePromise = null;

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

            html += '<div class="scene-section" id="generalScenesSection">';
            html += '<div class="scene-header">';
            html += '<div class="scene-title">通用角色場景</div>';
            html += '<button class="upload-btn scene-btn" id="saveGeneralScenesBtn" type="button">儲存</button>';
            html += '</div>';
            html += '<div class="scene-table-wrapper">';
            html += '<table class="scene-table">';
            html += '<thead><tr><th>場景設計</th><th>維持衣服設計</th><th>prompt</th></tr></thead>';
            html += '<tbody id="generalScenesTbody"></tbody>';
            html += '</table>';
            html += '</div>';
            html += '<div class="scene-footer">';
            html += '<button class="sort-btn scene-btn" id="addGeneralScenesRowBtn" type="button">新增一列</button>';
            html += '</div>';
            html += '<div id="generalScenesStatus" class="upload-status"></div>';
            html += '</div>';

            html += '<div class="scene-section" id="characterScenesSection">';
            html += '<div class="scene-header">';
            html += '<div class="scene-title">專用角色場景</div>';
            html += '<button class="upload-btn scene-btn" id="saveCharacterScenesBtn" type="button">儲存</button>';
            html += '</div>';
            html += '<div class="scene-table-wrapper">';
            html += '<table class="scene-table">';
            html += '<thead><tr><th>場景設計</th><th>維持衣服設計</th><th>prompt</th></tr></thead>';
            html += '<tbody id="characterScenesTbody"></tbody>';
            html += '</table>';
            html += '</div>';
            html += '<div class="scene-footer">';
            html += '<button class="sort-btn scene-btn" id="addCharacterScenesRowBtn" type="button">新增一列</button>';
            html += '</div>';
            html += '<div id="characterScenesStatus" class="upload-status"></div>';
            html += '</div>';

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
            const saveCharacterBtn = document.getElementById('saveCharacterScenesBtn');
            const addCharacterBtn = document.getElementById('addCharacterScenesRowBtn');

            if (!generalTbody || !characterTbody || !saveGeneralBtn || !addGeneralBtn || !saveCharacterBtn || !addCharacterBtn) {
                return;
            }

            addGeneralBtn.addEventListener('click', () => {
                appendSceneRow(generalTbody, { scenes: '', prompt: '', keepClothes: false });
            });

            addCharacterBtn.addEventListener('click', () => {
                appendSceneRow(characterTbody, { scenes: '', prompt: '', keepClothes: false });
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

            // 先放一行空白，避免載入中時是空表
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
            scenesInput.placeholder = '輸入場景設計';
            scenesTd.appendChild(scenesInput);

            const keepTd = document.createElement('td');
            keepTd.className = 'scene-checkbox-cell';
            const keepInput = document.createElement('input');
            keepInput.type = 'checkbox';
            keepInput.checked = normalized.keepClothes;
            keepInput.className = 'scene-checkbox';
            keepTd.appendChild(keepInput);

            const promptTd = document.createElement('td');
            const promptInput = document.createElement('textarea');
            promptInput.className = 'scene-textarea';
            promptInput.value = normalized.prompt;
            promptInput.placeholder = '輸入 prompt';
            promptTd.appendChild(promptInput);

            tr.append(scenesTd, keepTd, promptTd);
            tbody.appendChild(tr);
        }

        function normalizeSceneRow(row) {
            const scenes = (row?.scenes ?? row?.scene ?? row?.['場景設計'] ?? '').toString();
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

                // 全空列不寫入
                if (!scenes && !prompt && !keepClothes) {
                    continue;
                }

                result.push({
                    scenes,
                    prompt,
                    // 需求指定 key 名稱
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

        function encodeHfPath(path) {
            const parts = String(path || '').split('/').filter(Boolean);
            return parts.map(part => encodeURIComponent(part)).join('/');
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
                setStatus(statusElementId, '請先解鎖 token 才能載入', 'error');
                return;
            }

            const filePath = getScenesFilePath(type, loraName);
            setStatus(statusElementId, `載入中：/${filePath}`, 'loading');

            try {
                const json = await fetchRepoJsonFile(repoId, filePath, token);
                const rows = normalizeScenesFileContent(json);

                tbody.innerHTML = '';
                if (rows.length === 0) {
                    appendSceneRow(tbody, { scenes: '', prompt: '', keepClothes: false });
                    setStatus(statusElementId, `尚無資料：/${filePath}`, 'loading');
                    return;
                }

                rows.forEach(row => appendSceneRow(tbody, row));
                setStatus(statusElementId, `已載入：/${filePath}（${rows.length} 列）`, 'success');
            } catch (error) {
                // 解析失敗或權限問題
                setStatus(statusElementId, `載入失敗：/${filePath}（${error.message}）`, 'error');
            }
        }

        async function getHfHubModule() {
            if (!hfHubModulePromise) {
                hfHubModulePromise = import('https://esm.sh/@huggingface/hub');
            }
            return hfHubModulePromise;
        }

        async function saveScenesFromTable({ type, loraName, tbody, statusElementId, saveButton }) {
            const token = resolvedHfToken;
            const repoId = 'Gazai-ai/Gacha-LoRA';

            if (!token) {
                setStatus(statusElementId, '請先解鎖 token 才能儲存', 'error');
                return;
            }

            const filePath = getScenesFilePath(type, loraName);
            const rows = collectScenesFromTable(tbody);

            saveButton.disabled = true;
            setStatus(statusElementId, `儲存中：/${filePath}`, 'loading');

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

                setStatus(statusElementId, `已儲存：/${filePath}（${rows.length} 列）`, 'success');
            } catch (error) {
                setStatus(statusElementId, `儲存失敗：/${filePath}（${error.message}）`, 'error');
            } finally {
                saveButton.disabled = false;
            }
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
                .map(item => {
                    const domKey = item.domKey || makeImageDomKey(item.path);
                    const status = item.status || (item.objectUrl ? 'loaded' : 'loading');

                    if (status === 'loaded' && item.objectUrl) {
                        return `<div class="target-folder-item" data-img-key="${domKey}"><img src="${item.objectUrl}" alt="${escapeHtml(item.fileName)}"></div>`;
                    }

                    if (status === 'error') {
                        return `<div class="target-folder-item" data-img-key="${domKey}"><div class="target-folder-loading is-error">載入失敗</div></div>`;
                    }

                    return `<div class="target-folder-item" data-img-key="${domKey}"><div class="target-folder-loading"><div class="mini-spinner"></div><div class="loading-text">載入中...</div></div></div>`;
                })
                .join('');
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
                return;
            }

            if (entry.status === 'error') {
                tile.innerHTML = `<div class="target-folder-loading is-error">載入失敗</div>`;
                return;
            }

            tile.innerHTML = `<div class="target-folder-loading"><div class="mini-spinner"></div><div class="loading-text">載入中...</div></div>`;
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
            const progressUI = createRunpodProgressUI(times);
            if (progressUI) {
                progressUI.setType('loading');
                progressUI.setSummary(`準備執行 ${times} 次 Workflow...`, {
                    total: times,
                    finished: 0,
                    success: 0,
                    failed: 0,
                    running: 0
                });
            } else {
                showRunpodStatus(`準備執行 ${times} 次 Workflow...`, 'loading');
            }

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
                    if (progressUI) {
                        progressUI.setType(type);
                        progressUI.setSummary(message, {
                            total: times,
                            finished: finishedCount,
                            success: uploadedCount,
                            failed: failedCount,
                            running: runningCount
                        });
                        return;
                    }

                    const waitingCount = Math.max(0, times - finishedCount - runningCount);
                    showRunpodStatus(
                        `進度 ${finishedCount}/${times}（成功 ${uploadedCount}，失敗 ${failedCount}，進行中 ${runningCount}，等待 ${waitingCount}）`,
                        type
                    );
                }

                async function runSingleRound(round) {
                    renderProgress(`第 ${round}/${times} 次：送出 Runpod 任務...`);
                    if (progressUI) {
                        progressUI.setRoundState(round, 'submitting', '送出任務中');
                    }
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
                            return_format: 'base64'
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

                    renderProgress(`第 ${round}/${times} 次：Runpod 任務執行中`);
                    if (progressUI) {
                        progressUI.setRoundState(round, 'running', '生成中');
                    }

                    const output = await pollRunpodResult(endpointId, jobId, runpodToken, (progress) => {
                        if (!progressUI) {
                            return;
                        }
                        progressUI.setRoundRunningProgress(round, progress);
                    });
                    const imageInfo = extractLastGeneratedImageInfo(output);
                    const imageSrc = await resolveImageDownloadUrl(imageInfo);
                    console.log(`第 ${round}/${times} 次 Runpod 輸出結果:`, output, '提取的圖片資訊:', imageInfo, '最終下載 URL:', imageSrc);

                    if (!imageSrc) {
                        throw new Error(`第 ${round}/${times} 次：任務完成，但找不到最後生成圖片`);
                    }

                    if (progressUI) {
                        progressUI.setRoundState(round, 'uploading', '下載/上傳中');
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
                    if (progressUI) {
                        progressUI.setRoundState(round, 'done', '完成');
                    }

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
                        if (progressUI) {
                            progressUI.setRoundState(round, 'queued', '排隊中');
                        }

                        try {
                            await runSingleRound(round);
                        } catch (error) {
                            failedCount += 1;
                            failedRounds.push(`第 ${round} 次：${error.message}`);
                            renderProgress(`第 ${round}/${times} 次失敗`);
                            if (progressUI) {
                                progressUI.setRoundState(round, 'failed', String(error?.message || '失敗'));
                            }
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
                    renderProgress(`✗ Workflow 完成（成功 ${uploadedCount}/${times}，失敗 ${failedCount}）。${preview}`, 'error');
                } else {
                    renderProgress(`✓ Workflow 全部完成，已上傳 ${uploadedCount} 張圖片（共 ${times} 次）`, 'success');
                }
            } catch (error) {
                showRunpodStatus(`✗ Workflow 執行失敗: ${error.message}`, 'error');
            } finally {
                runpodBtn.disabled = false;
            }
        }

        function createRunpodProgressUI(times) {
            const runpodStatus = document.getElementById('runpodStatus');
            if (!runpodStatus) {
                return null;
            }

            const summaryEl = document.createElement('div');
            summaryEl.className = 'runpod-summary';

            const listEl = document.createElement('div');
            listEl.className = 'runpod-progress-list';

            const roundEls = Array.from({ length: times }, (_, index) => {
                const round = index + 1;

                const rowEl = document.createElement('div');
                rowEl.className = 'runpod-progress-row';

                const labelEl = document.createElement('div');
                labelEl.className = 'runpod-progress-label';
                labelEl.textContent = String(round);

                const barEl = document.createElement('div');
                barEl.className = 'runpod-progress-bar';

                const fillEl = document.createElement('div');
                fillEl.className = 'runpod-progress-fill is-waiting';
                fillEl.style.width = '0%';
                barEl.appendChild(fillEl);

                const stateEl = document.createElement('div');
                stateEl.className = 'runpod-progress-state';
                stateEl.textContent = '等待';

                rowEl.append(labelEl, barEl, stateEl);
                listEl.appendChild(rowEl);

                return { fillEl, stateEl, rowEl };
            });

            runpodStatus.innerHTML = '';
            runpodStatus.append(summaryEl, listEl);

            function setType(type) {
                runpodStatus.className = `upload-status show ${type}`;
            }

            function setSummary(message, stats) {
                const waitingCount = Math.max(0, (stats?.total || 0) - (stats?.finished || 0) - (stats?.running || 0));
                const line = `進度 ${stats?.finished || 0}/${stats?.total || 0}（成功 ${stats?.success || 0}，失敗 ${stats?.failed || 0}，進行中 ${stats?.running || 0}，等待 ${waitingCount}）`;
                summaryEl.textContent = line;
            }

            const stateMeta = {
                waiting: { label: '等待', percent: 0, cls: 'is-waiting' },
                queued: { label: '排隊中', percent: 1, cls: 'is-queued' },
                submitting: { label: '送出中', percent: 2, cls: 'is-submitting' },
                running: { label: '生成中', percent: 2, cls: 'is-running' },
                uploading: { label: '上傳中', percent: 99, cls: 'is-uploading' },
                done: { label: '完成', percent: 100, cls: 'is-done' },
                failed: { label: '失敗', percent: 100, cls: 'is-failed' }
            };

            function setRoundState(round, state, detail) {
                const item = roundEls[round - 1];
                if (!item) {
                    return;
                }

                const meta = stateMeta[state] || stateMeta.waiting;
                item.fillEl.className = `runpod-progress-fill ${meta.cls}`;
                item.fillEl.style.width = `${meta.percent}%`;
                item.stateEl.textContent = meta.label;
                item.rowEl.title = detail ? String(detail) : '';
            }

            function setRoundRunningProgress(round, progress) {
                const item = roundEls[round - 1];
                if (!item) {
                    return;
                }

                const max = Number(progress?.max);
                const value = Number(progress?.value);
                const ratio = (Number.isFinite(max) && max > 0 && Number.isFinite(value))
                    ? Math.min(1, Math.max(0, value / max))
                    : 0;

                // 排隊 1% + 送出 1% + 生成 97% + 上傳 1%
                const percent = 2 + Math.round(97 * ratio);
                item.fillEl.className = 'runpod-progress-fill is-running';
                item.fillEl.style.width = `${Math.min(99, Math.max(2, percent))}%`;
                item.stateEl.textContent = `生成中 ${Number.isFinite(value) ? value : 0}/${Number.isFinite(max) ? max : 0}`;
            }

            return {
                setType,
                setSummary,
                setRoundState,
                setRoundRunningProgress
            };
        }

        async function fetchGeneratedImageBlob(imageSrc) {
            const base64Blob = tryBuildBlobFromBase64(imageSrc);
            if (base64Blob) {
                return base64Blob;
            }

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
                    throw new Error('下載生成圖片被瀏覽器 CORS 限制擋下（S3/CloudFront 未允許目前網域）。請在來源端設定 Access-Control-Allow-Origin。');
                }

                throw error;
            }
        }

        function tryBuildBlobFromBase64(imageSrc) {
            if (typeof imageSrc !== 'string' || !imageSrc.trim()) {
                return null;
            }

            const trimmed = imageSrc.trim();

            const dataUrlMatch = trimmed.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/i);
            if (dataUrlMatch) {
                const mimeType = dataUrlMatch[1].toLowerCase();
                const base64Body = dataUrlMatch[2].replace(/\s/g, '');
                return base64ToBlob(base64Body, mimeType);
            }

            if (/^[A-Za-z0-9+/=\s]+$/.test(trimmed) && trimmed.length > 1000) {
                return base64ToBlob(trimmed.replace(/\s/g, ''), 'image/png');
            }

            return null;
        }

        function base64ToBlob(base64Body, mimeType) {
            const binary = atob(base64Body);
            const bytes = new Uint8Array(binary.length);
            for (let index = 0; index < binary.length; index += 1) {
                bytes[index] = binary.charCodeAt(index);
            }
            return new Blob([bytes], { type: mimeType || 'image/png' });
        }

        function parseS3ObjKey(objKey) {
            if (!objKey || typeof objKey !== 'string') {
                return null;
            }

            const cleanKey = objKey.replace(/^\/+/, '');
            const slashIndex = cleanKey.indexOf('/');
            if (slashIndex <= 0 || slashIndex >= cleanKey.length - 1) {
                return null;
            }

            return {
                bucket: cleanKey.slice(0, slashIndex),
                key: cleanKey.slice(slashIndex + 1)
            };
        }

        async function resolveImageDownloadUrl(imageInfo) {
            if (!imageInfo || !imageInfo.url) {
                return null;
            }

            const accessKeyId = privateTokenData?.AKI;
            const secretAccessKey = privateTokenData?.ASAK;
            const parsed = parseS3ObjKey(imageInfo.objKey);

            if (!accessKeyId || !secretAccessKey || !parsed) {
                return imageInfo.url;
            }

            try {
                const region = privateTokenData?.S3_REGION || privateTokenData?.s3_region || 'us-east-1';
                const [{ S3Client, GetObjectCommand }, { getSignedUrl }] = await Promise.all([
                    import('https://esm.sh/@aws-sdk/client-s3'),
                    import('https://esm.sh/@aws-sdk/s3-request-presigner')
                ]);

                const s3Client = new S3Client({
                    region,
                    credentials: {
                        accessKeyId,
                        secretAccessKey
                    }
                });

                return await getSignedUrl(
                    s3Client,
                    new GetObjectCommand({
                        Bucket: parsed.bucket,
                        Key: parsed.key
                    }),
                    { expiresIn: 3600 }
                );
            } catch (error) {
                console.warn('使用 AKI/ASAK 產生 S3 簽名 URL 失敗，退回 Runpod URL:', error?.message || error);
                return imageInfo.url;
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

        async function pollRunpodResult(endpointId, jobId, runpodToken, onProgress) {
            const intervalMs = 2000;
            const timeoutMs = 1200000;
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

                const progressMessage = statusData?.output?.message;
                if (progressMessage && typeof progressMessage === 'object' && !Array.isArray(progressMessage)) {
                    const max = Number(progressMessage.progress_1_max);
                    const value = Number(progressMessage.progress_1_value);
                    if (Number.isFinite(max) && Number.isFinite(value) && typeof onProgress === 'function') {
                        onProgress({
                            max,
                            value,
                            raw: progressMessage.raw || null
                        });
                    }
                }

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

        function extractLastGeneratedImageInfo(output) {
            if (output && typeof output === 'object') {
                if (Array.isArray(output.message) && output.message.length > 0) {
                    const lastMessage = output.message[output.message.length - 1];
                    if (lastMessage && typeof lastMessage.url === 'string' && /^https?:\/\//i.test(lastMessage.url)) {
                        return {
                            url: lastMessage.url,
                            objKey: typeof lastMessage.obj_key === 'string' ? lastMessage.obj_key : null
                        };
                    }
                }

                if (Array.isArray(output.download_files) && output.download_files.length > 0) {
                    const lastDownload = output.download_files[output.download_files.length - 1];
                    if (typeof lastDownload === 'string' && /^https?:\/\//i.test(lastDownload)) {
                        return { url: lastDownload, objKey: null };
                    }
                    if (lastDownload && typeof lastDownload.url === 'string' && /^https?:\/\//i.test(lastDownload.url)) {
                        return {
                            url: lastDownload.url,
                            objKey: typeof lastDownload.obj_key === 'string' ? lastDownload.obj_key : null
                        };
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

            return { url: candidates[candidates.length - 1], objKey: null };
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

                // 先把 UI placeholder 插入，避免等所有圖片讀完才顯示
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

                // 下載完成後再依排序重排一次（不影響已載入圖片）
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
