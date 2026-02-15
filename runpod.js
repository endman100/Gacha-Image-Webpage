function collectPromptJobsFromSceneTableBody(tbody) {
    if (!tbody) {
        return [];
    }

    const rows = Array.from(tbody.querySelectorAll('tr.scene-row'));
    const jobs = [];

    for (const tr of rows) {
        const textareas = tr.querySelectorAll('textarea.scene-textarea');
        const prompt = (textareas?.[1]?.value || '').trim();
        const checkbox = tr.querySelector('input.scene-checkbox');
        const keepClothes = !!checkbox?.checked;
        if (prompt) {
            jobs.push({ prompt, keepClothes });
        }
    }

    return jobs;
}

function summarizeRunpodJob(job) {
    const promptText = String(job?.prompt || '');
    return {
        promptLength: promptText.length,
        promptPreview: promptText.slice(0, 200),
        keepClothes: !!job?.keepClothes,
        promptIndex: job?.promptIndex,
        repeatIndex: job?.repeatIndex,
        promptTotal: job?.promptTotal,
        repeatTotal: job?.repeatTotal
    };
}

function buildRunpodErrorDetails(error) {
    if (error instanceof Error) {
        return {
            name: error.name,
            message: error.message,
            stack: error.stack || null,
            cause: error.cause || null
        };
    }

    return {
        name: 'Error',
        message: String(error),
        stack: null,
        cause: null
    };
}

function logRunpodFailure(context, error, details = {}) {
    const payload = {
        context,
        ...details,
        error: buildRunpodErrorDetails(error)
    };
    console.error('Runpod failure:', payload);
}

async function runWorkflowWithRunpod(loraName) {
    const runpodBtn = document.getElementById('runpodBtn');

    if (!privateTokenData || !privateTokenData.runpod) {
        showRunpodStatus('Runpod field not found in private token.', 'error');
        return;
    }

    if (!workflowData) {
        showRunpodStatus('workflow.json not found. Please re-search LoRA.', 'error');
        return;
    }

    const times = parseInt(document.getElementById('uploadTimes').value, 10);
    if (!times || times < 1) {
        showRunpodStatus('Please enter a valid run count.', 'error');
        return;
    }

    const generalJobs = collectPromptJobsFromSceneTableBody(document.getElementById('generalScenesTbody'));
    const characterJobs = collectPromptJobsFromSceneTableBody(document.getElementById('characterScenesTbody'));
    const baseJobs = [...generalJobs, ...characterJobs];

    if (baseJobs.length === 0) {
        showRunpodStatus('Please enter at least one prompt in General/Character-Specific scenes.', 'error');
        return;
    }

    const totalRounds = baseJobs.length * times;
    const jobs = [];
    for (let promptIndex = 0; promptIndex < baseJobs.length; promptIndex += 1) {
        const baseJob = baseJobs[promptIndex];
        for (let repeatIndex = 0; repeatIndex < times; repeatIndex += 1) {
            jobs.push({
                prompt: baseJob?.prompt || '',
                keepClothes: !!baseJob?.keepClothes,
                promptIndex: promptIndex + 1,
                repeatIndex: repeatIndex + 1,
                promptTotal: baseJobs.length,
                repeatTotal: times
            });
        }
    }

    const confirmed = window.confirm(`About to generate ${totalRounds} images. Continue?`);
    if (!confirmed) {
        showRunpodStatus('Generation canceled.', 'error');
        return;
    }

    runpodBtn.disabled = true;
    const progressUI = createRunpodProgressUI(totalRounds);
    if (progressUI) {
        progressUI.setType('loading');
        progressUI.setSummary(`Preparing to run ${totalRounds} workflows...`, {
            total: totalRounds,
            finished: 0,
            success: 0,
            failed: 0,
            running: 0
        });
    } else {
        showRunpodStatus(`Preparing to run ${totalRounds} workflows...`, 'loading');
    }

    try {
        const endpointId = 'vvknohtwuum3te';
        const runpodToken = privateTokenData.runpod;
        const hfToken = resolvedHfToken;
        const maxThreads = Math.min(5, totalRounds);

        if (!hfToken) {
            throw new Error('Hugging Face token not found. Please re-search LoRA.');
        }

        const repoId = 'Gazai-ai/Gacha-LoRA';
        const uploadPath = `image/${loraName}`;
        const hub = await getHfHubModule();
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
                    total: totalRounds,
                    finished: finishedCount,
                    success: uploadedCount,
                    failed: failedCount,
                    running: runningCount
                });
                return;
            }

            const waitingCount = Math.max(0, totalRounds - finishedCount - runningCount);
            showRunpodStatus(
                `Progress ${finishedCount}/${totalRounds} (success ${uploadedCount}, failed ${failedCount}, running ${runningCount}, waiting ${waitingCount})`,
                type
            );
        }

        async function runSingleRound(round, job) {
            const prompt = job?.prompt || '';
            const detail = (job && job.promptTotal > 0)
                ? `prompt ${job.promptIndex}/${job.promptTotal}（${job.repeatIndex}/${job.repeatTotal}）`
                : '';

            renderProgress(`Round ${round}/${totalRounds}: submitting Runpod job...${detail ? ` (${detail})` : ''}`);
            if (progressUI) {
                progressUI.setRoundState(round, 'submitting', 'Submitting');
            }
            const normalizedWorkflowInput = buildRunpodWorkflowInput(workflowData);
            const features = await getCharacterFeaturesForLora(loraName);
            const keepClothes = !!job?.keepClothes;
            const promptAdjustedWorkflowInput = applyCheckpointAndPromptOverrides(
                normalizedWorkflowInput,
                features,
                prompt,
                keepClothes
            );
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
                throw new Error(`Runpod start failed (HTTP ${runResponse.status}): ${errorText}`);
            }

            const runData = await runResponse.json();
            const jobId = runData.id;

            if (!jobId) {
                throw new Error('Runpod response missing job id');
            }

            renderProgress(`Round ${round}/${totalRounds}: Runpod job running`);
            if (progressUI) {
                progressUI.setRoundState(round, 'running', 'Generating');
            }

            const output = await pollRunpodResult(endpointId, jobId, runpodToken, (progress) => {
                if (!progressUI) {
                    return;
                }
                progressUI.setRoundRunningProgress(round, progress);
            });
            const imageInfo = extractLastGeneratedImageInfo(output);
            const imageSrc = await resolveImageDownloadUrl(imageInfo);
            console.log(`Round ${round}/${totalRounds} Runpod output:`, output, 'Extracted image info:', imageInfo, 'Final download URL:', imageSrc);

            if (!imageSrc) {
                throw new Error(`Round ${round}/${totalRounds}: job completed, but the final image was not found`);
            }

            if (progressUI) {
                progressUI.setRoundState(round, 'uploading', 'Downloading/Uploading');
            }
            const imageBlob = await fetchGeneratedImageBlob(imageSrc);
            const extension = detectImageExtension(imageBlob.type, imageSrc);
            const fileName = `${loraName}-${round}-${Date.now()}.${extension}`;

            await hub.uploadFiles({
                repo,
                accessToken: hfToken,
                files: [
                    {
                        path: `${uploadPath}/${fileName}`,
                        content: imageBlob
                    }
                ],
                commitTitle: `Upload workflow result ${round}/${totalRounds} for ${loraName}`
            });

            uploadedCount += 1;
            renderProgress(`Round ${round}/${totalRounds} complete, uploaded ${uploadedCount}/${totalRounds} to /${uploadPath}`);
            if (progressUI) {
                progressUI.setRoundState(round, 'done', 'Done');
            }

            await loadTargetFolderImages(loraName, hfToken, { reset: false });
        }

        async function worker() {
            while (true) {
                const round = nextRound;
                if (round > totalRounds) {
                    return;
                }
                nextRound += 1;
                runningCount += 1;
                renderProgress(`Round ${round}/${totalRounds}: queued`);
                if (progressUI) {
                    progressUI.setRoundState(round, 'queued', 'Queued');
                }

                const job = jobs[round - 1];

                try {
                    await runSingleRound(round, job);
                } catch (error) {
                    failedCount += 1;
                    logRunpodFailure('round-failed', error, {
                        loraName,
                        round,
                        totalRounds,
                        job: summarizeRunpodJob(job)
                    });
                    failedRounds.push(`Round ${round}: ${error.message}`);
                    renderProgress(`Round ${round}/${totalRounds} failed`);
                    if (progressUI) {
                        progressUI.setRoundState(round, 'failed', String(error?.message || 'Failed'));
                    }
                } finally {
                    runningCount -= 1;
                    finishedCount += 1;
                }
            }
        }

        renderProgress(`Starting parallel execution (max ${maxThreads} threads)`);

        await Promise.all(
            Array.from({ length: maxThreads }, () => worker())
        );

        if (failedCount > 0) {
            const preview = failedRounds.slice(0, 3).join('；');
            renderProgress(`✗ Workflow finished (success ${uploadedCount}/${totalRounds}, failed ${failedCount}). ${preview}`, 'error');
        } else {
            renderProgress(`✓ Workflow complete, uploaded ${uploadedCount} images (${totalRounds} total)`, 'success');
        }
    } catch (error) {
        logRunpodFailure('workflow-failed', error, {
            loraName,
            totalRounds
        });
        showRunpodStatus(`✗ Workflow failed: ${error.message}`, 'error');
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
        stateEl.textContent = 'Waiting';

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
        const line = `Progress ${stats?.finished || 0}/${stats?.total || 0} (success ${stats?.success || 0}, failed ${stats?.failed || 0}, running ${stats?.running || 0}, waiting ${waitingCount})`;
        summaryEl.textContent = line;
    }

    const stateMeta = {
        waiting: { label: 'Waiting', percent: 0, cls: 'is-waiting' },
        queued: { label: 'Queued', percent: 1, cls: 'is-queued' },
        submitting: { label: 'Submitting', percent: 2, cls: 'is-submitting' },
        running: { label: 'Generating', percent: 2, cls: 'is-running' },
        uploading: { label: 'Uploading', percent: 99, cls: 'is-uploading' },
        done: { label: 'Done', percent: 100, cls: 'is-done' },
        failed: { label: 'Failed', percent: 100, cls: 'is-failed' }
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

        // Queue 1% + submit 1% + generate 97% + upload 1%
        const percent = 2 + Math.round(97 * ratio);
        item.fillEl.className = 'runpod-progress-fill is-running';
        item.fillEl.style.width = `${Math.min(99, Math.max(2, percent))}%`;
        item.stateEl.textContent = `Generating ${Number.isFinite(value) ? value : 0}/${Number.isFinite(max) ? max : 0}`;
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
            throw new Error(`Failed to download generated image (HTTP ${response.status})`);
        }
        return await response.blob();
    } catch (error) {
        const isCorsLike = error instanceof TypeError
            || /Failed to fetch|CORS|Access-Control-Allow-Origin/i.test(String(error?.message || ''));

        if (isCorsLike) {
            throw new Error('Download blocked by browser CORS (S3/CloudFront does not allow this origin). Configure Access-Control-Allow-Origin on the source.');
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
        console.warn('Failed to generate S3 signed URL using AKI/ASAK; falling back to Runpod URL:', error?.message || error);
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
    let deadline = Date.now() + timeoutMs;
    let lastStatus = null;

    while (true) {
        if (Date.now() > deadline) {
            throw new Error('Runpod job timed out');
        }

        const statusRes = await fetch(`https://api.runpod.ai/v2/${endpointId}/status/${jobId}`, {
            headers: {
                'Authorization': `Bearer ${runpodToken}`
            }
        });

        if (!statusRes.ok) {
            const err = await statusRes.text();
            logRunpodFailure('status-request-failed', new Error('Runpod status query failed'), {
                endpointId,
                jobId,
                httpStatus: statusRes.status,
                responseText: err
            });
            throw new Error(`Status query failed (HTTP ${statusRes.status}): ${err}`);
        }

        const statusData = await statusRes.json();
        const status = statusData.status;

        if (status !== lastStatus) {
            if (status === 'IN_PROGRESS' || status === 'RUNNING') {
                deadline = Date.now() + timeoutMs;
            }
            lastStatus = status;
        }

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
            const failureError = new Error(`Runpod job failed: ${status}`);
            logRunpodFailure('status-failed', failureError, {
                endpointId,
                jobId,
                status,
                statusData
            });
            throw failureError;
        }

        await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
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

function applyCheckpointAndPromptOverrides(workflowInput, features, prompt, keepClothes = false) {
    const checkpointName = 'JANKUTrainedNoobaiRouwei_v50.safetensors';
    const headFeatures = (features?.character_head_features || '').trim();
    const bodyFeatures = (features?.character_body_features || '').trim();
    const clothingFeatures = (features?.character_clothing_features || '').trim();
    const scenePrompt = (prompt || '').toString().trim();
    let fullBodyPrompt;
    if (keepClothes) {
        fullBodyPrompt = [
            'masterpiece, best quality, highres, 8K, ultra detailed,',
            'GAZAI,',
            '1girl, full body, anime style,',
            headFeatures + ',',
            bodyFeatures + ',',
            clothingFeatures ? clothingFeatures + ',' : '',
            'looking at viewer,',
            scenePrompt ? scenePrompt + ',' : '',
            'detailed background, '
        ].filter(Boolean).join('\n');
    } else {
        fullBodyPrompt = [
            'masterpiece, best quality, highres, 8K, ultra detailed,',
            'GAZAI,',
            '1girl, full body, anime style,',
            headFeatures + ',',
            bodyFeatures + ',',
            'looking at viewer,',
            scenePrompt ? scenePrompt + ',' : '',
            'detailed background, '
        ].filter(Boolean).join('\n');
    }

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
            console.warn(`[Missing node] ${target.label}`);
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
