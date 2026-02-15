let geminiToken = '';

const GEMINI_MODEL = 'gemini-3-flash-preview';
const GEMINI_SYSTEM_INSTRUCTION = `You are a professional Stable Diffusion XL (SDXL) prompt generator. Your sole task is to convert the user's provided natural language description into a single line consisting purely of English tags, separated by commas and spaces (format example: tag1, tag2, tag3).
Strict rules:

The output must consist of only one line of tags. Absolutely no explanations, quotes, line breaks, numbering, prefaces, postscripts, quality-boosting tags, or negative prompts are allowed.
You must strictly select only the most suitable tags from the tag list provided below, covering as many elements from the description as comprehensively as possible.
Absolutely no quality-boosting tags are permitted (e.g., masterpiece, best quality, highres, ultra detailed, score_9, etc.).
Absolutely no specific character names or character-exclusive feature tags are allowed (e.g., names of specific anime or game characters, or their signature traits).
For elements such as clothing, accessories, background, environment, photographic perspective, etc., you may appropriately add tags from the tag list, but must not deviate from the user's intended design.
Only if a key element in the description is completely absent from the provided tag list and is critical to the image generation, you may add a minimal 1-2 very common, generic Danbooru-style English tags (must remain highly generic and avoid any creative additions), and place them at the end of the list.
Avoid repeating similar tags.
Tag ordering logic: action → clothing → background and environment → photographic perspective.

Tag List:
https://docs.google.com/spreadsheets/d/16wR5Zg_aQEbxLdrTOrB9cZf8QmsMrJnSGxFKbZVtrKc/edit?gid=2034408923#gid=2034408923`;

const GEMINI_SCENE_SYSTEM_INSTRUCTION = `You are a professional SDXL scene designer. Convert the request into a single, concise natural-language scene description in English.
Strict rules:

Output exactly one sentence. No lists, quotes, prefixes, or extra formatting.
Describe a clear character action first, then clothing, then background/environment, then camera perspective.
Do not include quality-boosting words or scores.
Do not use specific character names or character-exclusive traits.
Keep the description safe and avoid sensitive, violent, sexual, or illegal content.`;

async function requestGeminiSceneDesign() {
    if (!geminiToken) {
        throw new Error('Gemini token not found. Please re-search LoRA to load private token.');
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(geminiToken)}`;
    const payload = {
        systemInstruction: {
            role: 'system',
            parts: [{ text: GEMINI_SCENE_SYSTEM_INSTRUCTION }]
        },
        contents: [
            {
                role: 'user',
                parts: [{ text: 'Generate one scene design.' }]
            }
        ]
    };

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    const rawText = extractGeminiText(data);
    if (!rawText) {
        const blockReason = getGeminiBlockReason(data);
        console.error('Gemini scene response empty:', data);
        if (blockReason) {
            throw new Error(`Gemini blocked: ${blockReason}`);
        }
        throw new Error('Gemini scene response is empty.');
    }

    return rawText.replace(/\s+/g, ' ').trim();
}

async function requestGeminiPrompt(sceneText) {
    if (!geminiToken) {
        throw new Error('Gemini token not found. Please re-search LoRA to load private token.');
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(geminiToken)}`;
    const payload = {
        systemInstruction: {
            role: 'system',
            parts: [{ text: GEMINI_SYSTEM_INSTRUCTION }]
        },
        contents: [
            {
                role: 'user',
                parts: [{ text: sceneText }]
            }
        ]
    };

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    const rawText = extractGeminiText(data);
    if (!rawText) {
        const blockReason = getGeminiBlockReason(data);
        console.error('Gemini response empty:', data);
        if (blockReason) {
            throw new Error(`Gemini blocked: ${blockReason}`);
        }
        throw new Error('Gemini response is empty.');
    }

    return rawText.replace(/\s+/g, ' ').trim();
}

async function requestGeminiPromptStream(sceneText, onChunk) {
    if (!geminiToken) {
        throw new Error('Gemini token not found. Please re-search LoRA to load private token.');
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:streamGenerateContent?alt=sse&key=${encodeURIComponent(geminiToken)}`;
    const payload = {
        systemInstruction: {
            role: 'system',
            parts: [{ text: GEMINI_SYSTEM_INSTRUCTION }]
        },
        contents: [
            {
                role: 'user',
                parts: [{ text: sceneText }]
            }
        ]
    };

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
    }

    if (!response.body) {
        console.error('Gemini stream missing response body; falling back to non-stream.');
        const fallback = await requestGeminiPrompt(sceneText);
        if (typeof onChunk === 'function') {
            onChunk(fallback);
        }
        return fallback;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let combined = '';
    let receivedAny = false;

    async function consumeLine(line) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) {
            return;
        }

        const data = trimmed.replace(/^data:\s*/, '');
        if (!data || data === '[DONE]') {
            return;
        }

        let parsed;
        try {
            parsed = JSON.parse(data);
        } catch (_) {
            return;
        }

        const rawText = extractGeminiText(parsed);
        if (!rawText) {
            return;
        }

        const cleaned = rawText.replace(/\s+/g, ' ');
        const delta = cleaned.startsWith(combined)
            ? cleaned.slice(combined.length)
            : cleaned;
        combined += delta;
        receivedAny = true;
        if (typeof onChunk === 'function' && delta) {
            onChunk(delta);
        }
    }

    while (true) {
        const { value, done } = await reader.read();
        if (done) {
            break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';

        for (const line of lines) {
            await consumeLine(line);
        }
    }

    if (buffer.trim()) {
        await consumeLine(buffer);
    }

    const finalText = combined.replace(/\s+/g, ' ').trim();
    if (!finalText || !receivedAny) {
        console.error('Gemini stream empty; falling back to non-stream.', { finalText, receivedAny });
        const fallback = await requestGeminiPrompt(sceneText);
        if (typeof onChunk === 'function') {
            onChunk(fallback);
        }
        return fallback;
    }

    return finalText;
}

function extractGeminiText(data) {
    const candidate = data?.candidates?.[0];
    const parts = candidate?.content?.parts || [];
    const text = parts
        .map(part => (part?.text || '').trim())
        .filter(Boolean)
        .join(' ');
    return text.trim();
}

function getGeminiBlockReason(data) {
    const reason = data?.promptFeedback?.blockReason;
    if (!reason) {
        return '';
    }
    return String(reason).trim();
}
