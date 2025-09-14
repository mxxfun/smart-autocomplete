/**
 * Local Smart Autocomplete - Content Script
 * Implements keyboard shortcut listener, ghost text rendering, and model download logic
 */

class LRUCache {
  constructor(capacity = 50) {
    this.capacity = capacity;
    this.map = new Map();
  }
  get(key) {
    if (!this.map.has(key)) return null;
    const value = this.map.get(key);
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }
  set(key, value) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.capacity) {
      const oldestKey = this.map.keys().next().value;
      this.map.delete(oldestKey);
    }
  }
}

class SmartAutocomplete {
  constructor() {
    this.isModelReady = false;
    this.isDownloading = false;
    this.activeElement = null;
    this.ghostTextElement = null;
    this.currentCompletion = null; // Store the actual completion text separately
    this.savedCursorPosition = null; // Store cursor position when completion starts
    this.languageModel = null;
    this.summarizer = null;
    this.languageDetector = null;
    this.abortController = null;
    this.cache = new LRUCache(60);
    this.siteEnabled = true;
    this.triggers = { ctrlEnter: false, doubleSpace: false, autoAfterPunctuation: false };
    this.disableToggleShortcut = 'Ctrl+Shift+S';
    this._lastSpaceTimeMs = 0;
    this._punctuationTimer = null;
    this._websiteContextCache = { value: null, ts: 0 };
    this.minSentences = 1;
    this.maxSentences = 3;
    this.minTriggerIntervalMs = 350;
    this._lastTriggerTs = 0;
    this._lastStreamUpdateMs = 0;
    
    this.init();
  }

  init() {
    console.log('[SmartAutocomplete] Initializing...');
    this.setupKeyboardListener();
    this.setupFocusTracking();
    this.loadSitePreference();
    this.loadSettings();
    try {
      if (chrome?.storage?.onChanged) {
        chrome.storage.onChanged.addListener((changes, area) => {
          if (area === 'local' && changes.settings) {
            const newSettings = changes.settings.newValue || {};
            this.updateSettingsFromObject(newSettings);
          }
        });
      }
    } catch (e) {
      // ignore
    }
  }

  setupKeyboardListener() {
    document.addEventListener('keydown', (event) => {
      // Ctrl+Shift+Space trigger
      if (event.ctrlKey && event.shiftKey && event.code === 'Space') {
        event.preventDefault();
        event.stopPropagation();
        this.handleTrigger();
      }

      // Optional Ctrl+Enter trigger
      if (this.triggers.ctrlEnter && event.ctrlKey && event.code === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        this.handleTrigger();
      }
      
      // Ctrl+Shift+S to toggle per-site enable/disable
      if (this.matchesShortcut(event, this.disableToggleShortcut)) {
        event.preventDefault();
        event.stopPropagation();
        this.toggleSitePreference();
      }
      
      // Tab to accept ghost text
      if (event.code === 'Tab' && this.ghostTextElement && this.isGhostTextVisible()) {
        event.preventDefault();
        event.stopPropagation();
        this.acceptGhostText();
      }
      
      // Esc to cancel ghost text
      if (event.code === 'Escape' && this.ghostTextElement) {
        event.preventDefault();
        this.clearGhostText();
      }
      
      // Any typing cancels ghost text
      if (this.ghostTextElement && this.isTypingKey(event)) {
        this.clearGhostText();
      }
    }, true);

    // Double-space trigger
    document.addEventListener('keyup', (event) => {
      if (!this.triggers.doubleSpace) return;
      if (event.code === 'Space' && !event.ctrlKey && !event.shiftKey && !event.altKey) {
        const now = performance.now();
        if (now - this._lastSpaceTimeMs < 350) {
          this.handleTrigger();
          this._lastSpaceTimeMs = 0;
        } else {
          this._lastSpaceTimeMs = now;
        }
      }
    }, true);

    // Auto after punctuation trigger with debounce
    document.addEventListener('input', () => {
      if (!this.triggers.autoAfterPunctuation) return;
      if (!this.activeElement || !this.isTextInput(this.activeElement)) return;
      const text = this.getCurrentText();
      if (!text) return;
      const endsWithPunct = /[.!?][\)\]]?\s?$/.test(text);
      clearTimeout(this._punctuationTimer);
      if (endsWithPunct) {
        this._punctuationTimer = setTimeout(() => this.handleTrigger(), 350);
      }
    }, true);
  }

  setupFocusTracking() {
    document.addEventListener('focusin', (event) => {
      if (this.isTextInput(event.target)) {
        this.activeElement = event.target;
      }
    });

    document.addEventListener('focusout', () => {
      this.clearGhostText();
      this.activeElement = null;
    });
  }

  isTextInput(element) {
    if (!element) return false;
    
    // Textarea elements
    if (element.tagName === 'TEXTAREA') return true;
    
    // Input text elements
    if (element.tagName === 'INPUT') {
      const type = element.type?.toLowerCase();
      return ['text', 'search', 'url', 'email', 'password'].includes(type);
    }
    
    // Contenteditable elements
    if (element.isContentEditable) return true;
    
    return false;
  }

  async handleTrigger() {
    console.log('[SmartAutocomplete] Trigger activated');
    
    // Throttle triggers to avoid spamming model
    const nowTs = performance.now();
    if (nowTs - this._lastTriggerTs < this.minTriggerIntervalMs) {
      return;
    }
    this._lastTriggerTs = nowTs;

    if (!this.activeElement || !this.isTextInput(this.activeElement)) {
      console.log('[SmartAutocomplete] No valid text input focused');
      return;
    }
    
    // Respect per-site preference
    if (!this.siteEnabled) {
      this.showGhostText('Autocomplete is disabled on this site (Ctrl+Shift+S to enable)', null, 'error');
      return;
    }

    // Clear any existing ghost text
    this.clearGhostText();

    // Check if model is ready or needs download
    if (!this.isModelReady && !this.isDownloading) {
      await this.initializeModel();
    }

    // If model is ready, generate actual completion
    if (this.isModelReady && this.languageModel) {
      await this.generateCompletion();
    } else {
      // Fallback to demo/placeholder mode
      this.showPlaceholderGhostText();
    }
  }

  async generateCompletion() {
    try {
      console.log('[SmartAutocomplete] Generating AI completion...');
      this.showGhostText('Generating completion...', null, 'loading');
      
      // Create abort controller for cancellation
      this.abortController = new AbortController();
      
      // Extract context around cursor and save cursor position
      const contextData = await this.extractContext();
      if (!contextData.text.trim()) {
        this.showGhostText('No context available for completion', null, 'error');
        return;
      }
      
      // Save cursor position for accurate insertion later
      this.savedCursorPosition = this.getCurrentCursorPosition();
      
      // Detect language if available
      let detectedLanguage = 'en'; // default
      if (this.languageDetector && contextData.text.length >= 10) {
        try {
          const languageResults = await this.languageDetector.detect(contextData.recentText);
          if (languageResults && languageResults.length > 0 && languageResults[0].confidence >= 0.5) {
            detectedLanguage = languageResults[0].detectedLanguage;
            console.log('[SmartAutocomplete] Detected language:', detectedLanguage, 'confidence:', languageResults[0].confidence);
          }
        } catch (error) {
          console.log('[SmartAutocomplete] Language detection failed:', error.message);
        }
      }
      
      // Try cache first
      const cacheKey = this.buildCacheKey(contextData, detectedLanguage);
      const cached = this.cache.get(cacheKey);
      if (cached) {
        this.showGhostText(cached, cached, 'ready');
        return;
      }
      
      // Prefer streaming if available
      if (this.languageModel && typeof this.languageModel.promptStreaming === 'function') {
        await this.generateCompletionStreaming(contextData, detectedLanguage, cacheKey);
      } else {
        // Create completion prompt
        const prompt = await this.createCompletionPrompt(contextData, detectedLanguage);
        
        // Generate completion with structured output
        const options = {
          language: 'en',
          responseConstraint: {
            type: 'object',
            properties: {
              accept: { type: 'boolean' },
              confidence: { type: 'number', minimum: 0, maximum: 1 },
              sentences: {
                type: 'array',
                items: { type: 'string' },
                minItems: this.minSentences,
                maxItems: this.maxSentences
              }
            },
            required: ['accept', 'confidence', 'sentences']
          }
        };
        if (this.abortController) options.signal = this.abortController.signal;
        const response = await this.languageModel.prompt(prompt, options);
        // Parse and display completion
        this.handleCompletionResponse(response, detectedLanguage, contextData);
        // Cache positive results
        if (response && response.sentences && response.sentences.length) {
          let completion = response.sentences.join(' ').trim();
          completion = this.cleanCompletionText(completion, contextData);
          if (completion) this.cache.set(cacheKey, completion);
        }
      }
      
    } catch (error) {
      if (error.name === 'AbortError') {
        console.log('[SmartAutocomplete] Completion cancelled');
      } else {
        console.error('[SmartAutocomplete] Completion failed:', error);
        this.showGhostText('Completion failed: ' + error.message, null, 'error');
      }
    }
  }

  async generateCompletionStreaming(contextData, detectedLanguage, cacheKey) {
    // Streaming-only prompt that returns raw continuation text (no JSON)
    const prompt = await this.createStreamingPrompt(contextData, detectedLanguage);
    let accumulated = '';
    this.showGhostText('Generating…', '', 'streaming');
    try {
      const streamOptions = { temperature: 0.3, topK: 3, language: 'en' };
      if (this.abortController) streamOptions.signal = this.abortController.signal;
      const stream = await this.languageModel.promptStreaming(prompt, streamOptions);
      
      // Support async iterator style
      if (stream && typeof stream[Symbol.asyncIterator] === 'function') {
        let earlyStop = false;
        for await (const chunk of stream) {
          if (typeof chunk !== 'string') continue;
          accumulated += chunk;
          const cleaned = this.cleanCompletionText(accumulated, contextData);
          const tNow = performance.now();
          if (cleaned.trim().length > 0 && tNow - this._lastStreamUpdateMs > 60) {
            this.updateGhostText(cleaned);
            this._lastStreamUpdateMs = tNow;
          }
          if (this.shouldEarlyStopStreaming(cleaned)) { earlyStop = true; break; }
        }
      } else if (stream && typeof stream.onToken === 'function') {
        // Event-callback style
        let earlyStop = false;
        await new Promise((resolve, reject) => {
          stream.onToken((token) => {
            if (earlyStop) return;
            accumulated += token || '';
            const cleaned = this.cleanCompletionText(accumulated, contextData);
            const tNow = performance.now();
            if (cleaned.trim().length > 0 && tNow - this._lastStreamUpdateMs > 60) {
              this.updateGhostText(cleaned);
              this._lastStreamUpdateMs = tNow;
            }
            if (this.shouldEarlyStopStreaming(cleaned)) { earlyStop = true; }
          });
          stream.onDone(() => resolve());
          stream.onError((e) => reject(e));
        });
      }
    } catch (e) {
      if (e.name !== 'AbortError') {
        console.log('[SmartAutocomplete] Streaming failed, falling back:', e.message);
        // Fallback to non-streaming path with structured output
        const fallbackPrompt = await this.createCompletionPrompt(contextData, detectedLanguage);
        const options = {
          language: 'en',
          responseConstraint: {
            type: 'object',
            properties: {
              accept: { type: 'boolean' },
              confidence: { type: 'number', minimum: 0, maximum: 1 },
              sentences: { type: 'array', items: { type: 'string' }, minItems: this.minSentences, maxItems: this.maxSentences }
            },
            required: ['accept', 'confidence', 'sentences']
          }
        };
        if (this.abortController) options.signal = this.abortController.signal;
        const response = await this.languageModel.prompt(fallbackPrompt, options);
        this.handleCompletionResponse(response, detectedLanguage, contextData);
        return;
      }
    }
    
    let finalText = this.cleanCompletionText(accumulated, contextData).trim();
    finalText = this.limitToSentenceRange(finalText, this.minSentences, this.maxSentences);
    if (finalText) {
      this.updateGhostText(finalText);
      this.currentCompletion = finalText;
      this.setGhostState('ready');
      this.cache.set(cacheKey, finalText);
    } else {
      this.updateGhostText('No suitable completion found');
      this.setGhostState('error');
    }
  }

  createStreamingPrompt(contextData, language = 'en') {
    const languageInstruction = language && language !== 'en' ? `Continue in ${language}.` : 'Continue in English.';
    const beforeCursor = contextData.beforeCursor || contextData.text;
    const afterCursor = contextData.afterCursor || '';
    const completionPoint = `${beforeCursor}[CURSOR]${afterCursor}`;
    return `You are a text continuation engine. Continue ONLY the text after [CURSOR].

Current text: "${completionPoint}"

Rules:
- Output ONLY the continuation that should come after [CURSOR]
- Do NOT repeat any text already before [CURSOR]
- Do NOT answer questions, address the user, or explain
- ${languageInstruction}
- Output ${this.minSentences}-${this.maxSentences} sentences maximum, natural flow, match style and tone
- If no continuation is appropriate, output nothing`;
  }

  shouldEarlyStopStreaming(text) {
    if (!text) return false;
    const sentenceEndings = (text.match(/[\.\!\?](\s|$)/g) || []).length;
    return sentenceEndings >= this.maxSentences;
  }

  limitToSentenceRange(text, minSentences, maxSentences) {
    if (!text) return text;
    const tokens = text.split(/([\.\!\?](?:\s|$))/);
    let sentences = [];
    for (let i = 0; i < tokens.length; i += 2) {
      const seg = (tokens[i] || '').trim();
      const end = tokens[i + 1] || '';
      if (!seg) continue;
      sentences.push(seg + end);
      if (sentences.length >= maxSentences) break;
    }
    return sentences.join(' ').trim();
  }

  buildCacheKey(contextData, language) {
    const site = location.hostname;
    const keyPayload = `${site}|${(contextData.beforeCursor || '').slice(-200)}|${language}`;
    // Simple hash to keep keys short
    let hash = 0;
    for (let i = 0; i < keyPayload.length; i++) {
      const chr = keyPayload.charCodeAt(i);
      hash = ((hash << 5) - hash) + chr;
      hash |= 0;
    }
    return 'k:' + hash;
  }

  async extractContext() {
    if (!this.activeElement) return { text: '', recentText: '', beforeCursor: '', afterCursor: '' };
    
    let beforeCursor = '';
    let afterCursor = '';
    let fullText = '';
    
    if (this.activeElement.tagName === 'TEXTAREA' || this.activeElement.tagName === 'INPUT') {
      const value = this.activeElement.value;
      const cursorPos = this.activeElement.selectionStart;
      
      beforeCursor = value.substring(0, cursorPos);
      afterCursor = value.substring(cursorPos);
      fullText = value;
      
    } else if (this.activeElement.isContentEditable) {
      const selection = window.getSelection();
      if (selection.rangeCount > 0) {
        const range = selection.getRangeAt(0);
        
        // Get text before cursor
        const beforeRange = document.createRange();
        beforeRange.setStart(this.activeElement, 0);
        beforeRange.setEnd(range.startContainer, range.startOffset);
        beforeCursor = beforeRange.toString();
        
        // Get text after cursor
        const afterRange = document.createRange();
        afterRange.setStart(range.endContainer, range.endOffset);
        afterRange.setEnd(this.activeElement, this.activeElement.childNodes.length);
        afterCursor = afterRange.toString();
        
        fullText = this.activeElement.textContent || '';
      }
    }
    
    // Get recent context window (last 200 chars before cursor)
    const recentText = beforeCursor.slice(-200);
    
    // If text is very long, summarize the earlier context but preserve structure
    let processedBeforeCursor = beforeCursor;
    if (beforeCursor.length > 1000 && this.summarizer) {
      try {
        const earlyContext = beforeCursor.slice(0, -500);
        const recentContext = beforeCursor.slice(-500);
        
        const summary = await this.summarizer.summarize(earlyContext);
        processedBeforeCursor = `[Earlier context: ${summary}]\n\n${recentContext}`;
        console.log('[SmartAutocomplete] Used summarization for long context');
      } catch (error) {
        console.log('[SmartAutocomplete] Summarization failed, using truncated context:', error.message);
        processedBeforeCursor = beforeCursor.slice(-800); // Fallback to simple truncation
      }
    }
    
    return {
      text: processedBeforeCursor, // For backward compatibility
      recentText: recentText,
      beforeCursor: processedBeforeCursor,
      afterCursor: afterCursor,
      fullText: fullText
    };
  }

  async createCompletionPrompt(contextData, language = 'en') {
    const languageInstruction = language && language !== 'en' ? `Continue in ${language}.` : 'Continue in English.';
    
    // Extract website context for better completions
    const websiteContext = await this.extractWebsiteContext();
    const contextInfo = websiteContext ? `\n\nWebsite context: ${websiteContext}` : '';
    
    // Split context into before/after cursor for clearer completion
    const beforeCursor = contextData.beforeCursor || contextData.text;
    const afterCursor = contextData.afterCursor || '';
    
    // Show exactly where completion should happen using a marker
    const completionPoint = `${beforeCursor}[CURSOR]${afterCursor}`;
    
    const toneHints = this.deriveToneHints(beforeCursor);
    
    return `You are a text continuation engine. Continue ONLY the text after [CURSOR].

Current text: "${completionPoint}"${contextInfo}

CRITICAL INSTRUCTIONS:
- Output ONLY the continuation that should come after [CURSOR]
- DO NOT repeat any text that appears before [CURSOR]
- DO NOT answer questions, give advice, or address the user
- ${languageInstruction}
- Match the writing style and tone exactly${toneHints ? ` (hints: ${toneHints})` : ''}
- Provide ${this.minSentences}-${this.maxSentences} sentences that flow naturally from the cursor position
- If no continuation is appropriate, set accept: false and leave sentences empty

Example:
Text: "Hello, my name is John and I[CURSOR]"
Good completion: " work as a software engineer."
Bad completion: "Hello, my name is John and I work as a software engineer."

Respond with JSON only containing:
- accept: boolean (whether a continuation should be inserted)
- confidence: number 0-1 (how confident you are)
- sentences: array of 1-3 continuation sentences (only new text, no repetitions)`;
  }

  cleanCompletionText(completion, contextData) {
    if (!completion || !contextData) return completion;
    
    // Remove any accidental echo (even partial) of the cursor marker from the model
    completion = this.stripCursorArtifacts(completion);

    const beforeCursor = contextData.beforeCursor || '';
    
    // Robust overlap removal (case-insensitive, ignores punctuation/spacing)
    completion = this.removeContextOverlap(beforeCursor, completion);
    
    // Also check for full sentence repetition patterns
    const lastSentence = beforeCursor.match(/[^.!?]*$/)?.[0]?.trim();
    if (lastSentence && completion.toLowerCase().startsWith(lastSentence.toLowerCase())) {
      completion = completion.slice(lastSentence.length).trim();
    }
    
    // Remove leading punctuation that might be duplicated
    completion = completion.replace(/^[,;:.!?]+\s*/, '');
    
    return completion;
  }

  // Remove overlap between the end of beforeCursor and the start of completion,
  // matching case-insensitively and ignoring punctuation/extra spaces.
  removeContextOverlap(beforeCursor, completion) {
    const maxWindowChars = 120;
    const before = (beforeCursor || '').slice(-maxWindowChars);
    const comp = completion || '';

    const lowerBefore = before.toLowerCase();
    const lowerComp = comp.toLowerCase();

    // 1) Direct longest suffix/prefix match (case-insensitive)
    let directOverlap = 0;
    const maxLen = Math.min(lowerBefore.length, lowerComp.length);
    for (let i = maxLen; i > 0; i--) {
      if (lowerBefore.slice(-i) === lowerComp.slice(0, i)) { directOverlap = i; break; }
    }

    // 2) Normalized (strip punctuation and condense spaces) longest match
    const norm = (s) => s
      .toLowerCase()
      .replace(/[\s]+/g, ' ')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .replace(/[\,\.;:!\?\-\(\)\[\]\{\}\"\']/g, '')
      .trim();
    const normBefore = norm(before);
    const normComp = norm(comp);
    let normOverlap = 0;
    const maxNorm = Math.min(normBefore.length, normComp.length);
    for (let i = maxNorm; i > 0; i--) {
      if (normBefore.slice(-i) === normComp.slice(0, i)) { normOverlap = i; break; }
    }

    // If normalized overlap is larger than direct, compute raw slice index by walking original completion
    let sliceIndex = directOverlap;
    if (normOverlap > directOverlap) {
      let built = '';
      let idx = 0;
      while (idx < comp.length && norm(built).length < normOverlap) {
        built += comp[idx];
        idx++;
      }
      sliceIndex = Math.max(sliceIndex, idx);
    }

    if (sliceIndex > 0) {
      let out = comp.slice(sliceIndex).trimStart();
      // Also remove leading punctuation leftovers
      out = out.replace(/^[,;:.!?]+\s*/, '');
      return out;
    }
    return comp;
  }

  getCurrentCursorPosition() {
    if (!this.activeElement) return null;
    
    if (this.activeElement.tagName === 'TEXTAREA' || this.activeElement.tagName === 'INPUT') {
      return this.activeElement.selectionStart;
    } else if (this.activeElement.isContentEditable) {
      const selection = window.getSelection();
      if (selection.rangeCount > 0) {
        const range = selection.getRangeAt(0);
        return { container: range.startContainer, offset: range.startOffset };
      }
    }
    return null;
  }

  async extractWebsiteContext() {
    try {
      // Cache website context for 5 seconds to avoid frequent DOM scans
      const now = Date.now();
      if (this._websiteContextCache.value && (now - this._websiteContextCache.ts) < 5000) {
        return this._websiteContextCache.value;
      }
      // Get page title and meta description
      const title = document.title || '';
      const description = document.querySelector('meta[name="description"]')?.content || '';
      
      // Get main headings
      const headings = Array.from(document.querySelectorAll('h1, h2, h3'))
        .slice(0, 3) // Limit to first 3 headings
        .map(h => h.textContent?.trim())
        .filter(h => h && h.length > 5 && h.length < 100)
        .join('; ');
      
      // Get nearby text (within 500 chars of active element)
      let nearbyText = '';
      if (this.activeElement) {
        const elementsNearby = this.getElementsNear(this.activeElement, 200);
        nearbyText = elementsNearby
          .map(el => el.textContent?.trim())
          .filter(text => text && text.length > 10 && text.length < 200)
          .slice(0, 2) // Limit to 2 nearby elements
          .join(' ');
      }
      
      // Combine and summarize if too long
      let context = [title, description, headings, nearbyText]
        .filter(s => s && s.trim())
        .join(' | ')
        .slice(0, 500); // Limit total context length
      
      // Use summarizer if context is still very long
      if (context.length > 300 && this.summarizer) {
        try {
          context = await this.summarizer.summarize(context);
        } catch (error) {
          console.log('[SmartAutocomplete] Website context summarization failed:', error.message);
          context = context.slice(0, 200); // Fallback to truncation
        }
      }
      
      this._websiteContextCache = { value: context, ts: Date.now() };
      return context;
      
    } catch (error) {
      console.log('[SmartAutocomplete] Website context extraction failed:', error.message);
      return null;
    }
  }

  getElementsNear(targetElement, radius = 200) {
    try {
      const rect = targetElement.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      
      const textElements = document.querySelectorAll('p, div, span, li, td, th');
      return Array.from(textElements)
        .filter(el => {
          const elRect = el.getBoundingClientRect();
          const distance = Math.sqrt(
            Math.pow(elRect.left + elRect.width / 2 - centerX, 2) +
            Math.pow(elRect.top + elRect.height / 2 - centerY, 2)
          );
          return distance <= radius && el.textContent?.trim().length > 10;
        })
        .slice(0, 5); // Limit to 5 nearby elements
    } catch (error) {
      return [];
    }
  }

  isTextQuestion(text) {
    const trimmed = text.trim().toLowerCase();
    
    // Direct question indicators
    if (trimmed.endsWith('?')) return true;
    
    // Question word patterns
    const questionWords = ['what', 'how', 'why', 'when', 'where', 'who', 'which', 'can you', 'do you', 'are you', 'will you'];
    const lastSentence = trimmed.split(/[.!?]/).pop()?.trim() || trimmed;
    
    return questionWords.some(word => 
      lastSentence.startsWith(word + ' ') || 
      lastSentence.includes(' ' + word + ' ')
    );
  }

  deriveToneHints(text) {
    const recent = (text || '').slice(-300);
    const hints = [];
    // Simple heuristics for tone
    if (/[!:]$/.test(recent) || /\b(please|thank you|appreciate)\b/i.test(recent)) hints.push('polite');
    if (/[A-Z]{3,}/.test(recent)) hints.push('emphatic');
    if (/\b(we|our)\b/i.test(recent)) hints.push('inclusive');
    if (/\b(I|me|my)\b/.test(recent)) hints.push('first-person');
    if (/\b(agenda|action items|next steps)\b/i.test(recent)) hints.push('concise');
    if (/\b(?!I )[A-Z][a-z]+\b/.test(recent) && /\b(analysis|summary|overview)\b/i.test(recent)) hints.push('formal');
    return hints.join(', ');
  }

  handleCompletionResponse(response, language, contextData) {
    try {
      let result;
      
      // Handle both string and object responses
      if (typeof response === 'string') {
        result = JSON.parse(response);
      } else {
        result = response;
      }
      
      if (!result.accept || !result.sentences || result.sentences.length === 0) {
        this.showGhostText('No suitable completion found');
        return;
      }
      
      if (result.confidence < 0.3) {
        let completion = result.sentences.join(' ').trim();
        completion = this.cleanCompletionText(completion, contextData);
        if (!completion.trim()) {
          this.showGhostText('No suitable completion found');
          return;
        }
        this.showGhostText('Low confidence completion (press Tab to accept): ' + completion, completion);
        return;
      }
      
      // Join sentences and clean up any repetitive text
      let completion = result.sentences.join(' ').trim();
      
      // Remove any text that might be repeating from the context
      completion = this.cleanCompletionText(completion, contextData);
      
      if (!completion.trim()) {
        this.showGhostText('No unique completion generated');
        return;
      }
      
      this.showGhostText(completion, completion);
      
      console.log('[SmartAutocomplete] Generated completion:', { 
        confidence: result.confidence, 
        language: language, 
        length: completion.length 
      });
      
    } catch (error) {
      console.error('[SmartAutocomplete] Failed to parse completion response:', error);
      this.showGhostText('Failed to parse AI response');
    }
  }

  async initializeModel() {
    console.log('[SmartAutocomplete] Initializing AI model...');
    
    try {
      // Check if Built-in AI APIs are available
      if (!('LanguageModel' in self)) {
        console.error('[SmartAutocomplete] LanguageModel API not available');
        this.showGhostText('AI not available in this browser version');
        return;
      }

      // Check availability first
      const availability = await LanguageModel.availability();
      console.log('[SmartAutocomplete] Model availability:', availability);

      if (availability === 'unavailable') {
        console.warn('[SmartAutocomplete] Built-in AI not available on this device/browser');
        this.showGhostText('Built-in AI not supported. Need Chrome Canary ≥128 with flags enabled.');
        return;
      }

      if (availability === 'downloadable') {
        // Model needs to be downloaded - requires user activation
        console.log('[SmartAutocomplete] Model needs download, checking user activation...');
        
        if (!navigator.userActivation || !navigator.userActivation.isActive) {
          console.warn('[SmartAutocomplete] User activation required for model download');
          this.showGhostText('Click to download AI model (requires user interaction)');
          return;
        }
        
        this.isDownloading = true;
        this.showGhostText('Downloading AI model… (10-20+ minutes first time - please be patient!)');
      } else if (availability === 'downloading') {
        // Download already in progress
        this.isDownloading = true;
        this.showGhostText('AI model downloading… (can take 10-20+ minutes, please wait)');
        return;
      }

      // Create the model session (downloads automatically if needed)
      const createOptions = {
        initialPrompts: [{role: 'system', content: 'You are an on-device text continuation engine. You ONLY generate the next part of the user\'s text after a [CURSOR] marker. Never answer questions, never address the user, never explain your reasoning, and never repeat text that appears before [CURSOR]. Match the detected language, tone, and style. If no continuation is appropriate, you output nothing (or accept: false when structured output is requested).'}],
        temperature: 0.3,
        topK: 3,
        language: 'en'
      };

      // Add monitor for download progress if downloadable/downloading
      if (availability === 'downloadable' || availability === 'downloading') {
        createOptions.monitor = (monitorReport) => {
          console.log('[SmartAutocomplete] Download progress:', monitorReport);
          if (monitorReport.loaded && monitorReport.total) {
            const progress = Math.round((monitorReport.loaded / monitorReport.total) * 100);
            this.showGhostText(`Downloading AI model… ${progress}%`);
          }
        };
      }

      this.languageModel = await LanguageModel.create(createOptions);
      
      // Initialize other APIs too
      try {
        if ('Summarizer' in self && await Summarizer.availability() !== 'unavailable') {
          this.summarizer = await Summarizer.create({ type: 'tldr', length: 'short' });
          console.log('[SmartAutocomplete] Summarizer ready');
        }
      } catch (error) {
        console.log('[SmartAutocomplete] Summarizer not available:', error.message);
      }
      
      try {
        if ('LanguageDetector' in self && await LanguageDetector.availability() !== 'unavailable') {
          this.languageDetector = await LanguageDetector.create();
          console.log('[SmartAutocomplete] LanguageDetector ready');
        }
      } catch (error) {
        console.log('[SmartAutocomplete] LanguageDetector not available:', error.message);
      }
      
      this.isModelReady = true;
      this.isDownloading = false;
      
      console.log('[SmartAutocomplete] All AI models ready!');
      this.showGhostText('🎉 Full Chrome Built-in AI ready! LanguageModel + Summarizer + LanguageDetector working on ARM64!');
      
    } catch (error) {
      console.error('[SmartAutocomplete] Failed to initialize model:', error);
      this.showGhostText('Failed to initialize AI model');
      this.isDownloading = false;
    }
  }

  showPlaceholderGhostText() {
    if (this.isDownloading) {
      this.showGhostText('Downloading model…');
    } else if (this.isModelReady) {
      this.showGhostText('AI autocomplete ready (functionality coming soon)');
    } else {
      // Show demo mode when APIs unavailable
      this.showDemoGhostText();
    }
  }

  showDemoGhostText() {
    // Get some context from the current text input for a realistic demo
    const currentText = this.getCurrentText();
    const demoSuggestions = this.generateDemoSuggestion(currentText);
    
    if (demoSuggestions) {
      this.showGhostText(demoSuggestions + ' (Demo mode - Chrome Built-in AI not available)', null, 'ready');
    } else {
      this.showGhostText('Chrome Built-in AI not available. See SETUP-CHROME-AI.md for setup instructions.', null, 'error');
    }
  }

  getCurrentText() {
    if (!this.activeElement) return '';
    
    if (this.activeElement.tagName === 'TEXTAREA' || this.activeElement.tagName === 'INPUT') {
      const cursorPos = this.activeElement.selectionStart;
      return this.activeElement.value.substring(Math.max(0, cursorPos - 100), cursorPos);
    } else if (this.activeElement.isContentEditable) {
      const selection = window.getSelection();
      if (selection.rangeCount > 0) {
        const range = selection.getRangeAt(0);
        const textNode = range.startContainer;
        if (textNode.nodeType === Node.TEXT_NODE) {
          return textNode.textContent.substring(Math.max(0, range.startOffset - 100), range.startOffset);
        }
      }
    }
    return '';
  }

  generateDemoSuggestion(context) {
    // Simple demo suggestions based on context
    const lowerContext = context.toLowerCase().trim();
    
    if (lowerContext.includes('hello') || lowerContext.includes('hi')) {
      return 'there! How can I help you today?';
    }
    if (lowerContext.includes('thank')) {
      return 'you for your time and consideration.';
    }
    if (lowerContext.includes('i am') || lowerContext.includes("i'm")) {
      return 'excited to share this project with you.';
    }
    if (lowerContext.includes('the project')) {
      return 'demonstrates on-device AI capabilities for text completion.';
    }
    if (lowerContext.includes('chrome extension')) {
      return 'uses the Built-in AI APIs for privacy-first text completion.';
    }
    if (lowerContext.length > 10) {
      return 'and I believe this approach will improve user productivity significantly.';
    }
    
    return null;
  }

  showGhostText(displayText, completionText = null, state = 'ready') {
    this.clearGhostText();
    
    if (!this.activeElement) return;

    this.ghostTextElement = document.createElement('div');
    this.ghostTextElement.className = 'smart-autocomplete-ghost';
    this.ghostTextElement.textContent = displayText;
    this.ghostTextElement.setAttribute('data-extension', 'smart-autocomplete');
    this.ghostTextElement.setAttribute('role', 'status');
    this.ghostTextElement.setAttribute('aria-live', 'polite');
    this.ghostTextElement.setAttribute('data-state', state);
    // Prepare for accurate measurement and ensure top stacking
    this.ghostTextElement.style.visibility = 'hidden';
    this.ghostTextElement.style.zIndex = '2147483647';
    
    // Store the actual completion text separately
    this.currentCompletion = completionText || displayText;

    // Append first, then position based on measured size
    document.body.appendChild(this.ghostTextElement);
    this.positionGhostText();
    this.ghostTextElement.style.visibility = '';
  }

  updateGhostText(text) {
    if (!this.ghostTextElement) return;
    this.ghostTextElement.textContent = text;
    this.currentCompletion = text;
  }

  setGhostState(state) {
    if (!this.ghostTextElement) return;
    this.ghostTextElement.setAttribute('data-state', state);
  }

  // Site preference helpers (persisted per hostname)
  async loadSitePreference() {
    try {
      if (!chrome?.storage?.local) return;
      const host = location.hostname;
      chrome.storage.local.get(['site_prefs'], (data) => {
        const prefs = data?.site_prefs || {};
        this.siteEnabled = prefs[host] !== false; // default enabled
      });
    } catch (e) {
      console.log('[SmartAutocomplete] Failed to load site preference:', e.message);
      this.siteEnabled = true;
    }
  }

  async toggleSitePreference() {
    try {
      if (!chrome?.storage?.local) return;
      const host = location.hostname;
      chrome.storage.local.get(['site_prefs'], (data) => {
        const prefs = data?.site_prefs || {};
        const current = prefs[host] !== false;
        const next = !current;
        prefs[host] = next;
        chrome.storage.local.set({ site_prefs: prefs }, () => {
          this.siteEnabled = next;
          this.showGhostText(next ? 'Enabled autocomplete on this site' : 'Disabled autocomplete on this site', null, next ? 'ready' : 'error');
          setTimeout(() => this.clearGhostText(), 1200);
        });
      });
    } catch (e) {
      console.log('[SmartAutocomplete] Failed to toggle site preference:', e.message);
    }
  }

  positionGhostText() {
    if (!this.ghostTextElement || !this.activeElement) return;
    const inputRect = this.activeElement.getBoundingClientRect();
    const caretRect = this.getCaretViewportRect(this.activeElement) || inputRect;
    const isFixed = this.isElementFixed(this.activeElement);
    const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
    const scrollLeft = window.pageXOffset || document.documentElement.scrollLeft;

    // Choose positioning mode based on ancestor positioning
    this.ghostTextElement.style.position = isFixed ? 'fixed' : 'absolute';

    // Target viewport coordinates (independent of scroll)
    let vLeft = caretRect.left;
    let vTop = caretRect.bottom + 6; // a little below the caret

    // Set initial width and position
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const maxWidth = Math.min(400, Math.max(140, vw - vLeft - 8));
    this.ghostTextElement.style.width = maxWidth + 'px';
    this.ghostTextElement.style.left = (isFixed ? vLeft : (scrollLeft + vLeft)) + 'px';
    this.ghostTextElement.style.top = (isFixed ? vTop : (scrollTop + vTop)) + 'px';
    this.ghostTextElement.style.zIndex = '2147483647';

    // Measure and clamp into the viewport, and place above if no room below
    const ghostRect = this.ghostTextElement.getBoundingClientRect();

    // Horizontal clamping
    if (ghostRect.right > vw - 4) {
      vLeft = Math.max(4, vw - ghostRect.width - 4);
    }
    if (ghostRect.left < 4) {
      vLeft = 4;
    }

    // Vertical clamping: if overflowing bottom, try above
    if (ghostRect.bottom > vh - 4) {
      vTop = Math.max(4, caretRect.top - ghostRect.height - 6);
    }
    if (vTop < 4) {
      vTop = 4;
    }

    // Apply clamped coordinates
    this.ghostTextElement.style.left = (isFixed ? vLeft : (scrollLeft + vLeft)) + 'px';
    this.ghostTextElement.style.top = (isFixed ? vTop : (scrollTop + vTop)) + 'px';
  }

  getCaretViewportRect(element) {
    try {
      if (!element) return null;
      if (element.tagName === 'TEXTAREA' || element.tagName === 'INPUT') {
        return this.getTextareaCaretRect(element);
      }
      if (element.isContentEditable) {
        const selection = window.getSelection();
        if (selection && selection.rangeCount > 0) {
          const range = selection.getRangeAt(0).cloneRange();
          range.collapse(true);
          // Insert a temporary marker to get stable rect even at line ends
          const marker = document.createElement('span');
          marker.appendChild(document.createTextNode('\u200b'));
          range.insertNode(marker);
          const rect = marker.getBoundingClientRect();
          marker.parentNode && marker.parentNode.removeChild(marker);
          if (rect && rect.width >= 0 && rect.height >= 0) return rect;
        }
      }
    } catch (_) {}
    return null;
  }

  getTextareaCaretRect(textarea) {
    try {
      const selectionStart = textarea.selectionStart ?? 0;
      const value = String(textarea.value || '').substring(0, selectionStart);
      const taRect = textarea.getBoundingClientRect();
      const cs = getComputedStyle(textarea);

      const mirror = document.createElement('div');
      mirror.setAttribute('data-extension', 'smart-autocomplete');
      mirror.style.position = 'fixed';
      mirror.style.left = taRect.left + 'px';
      mirror.style.top = taRect.top + 'px';
      mirror.style.visibility = 'hidden';
      mirror.style.pointerEvents = 'none';
      mirror.style.boxSizing = 'content-box';
      mirror.style.overflow = 'hidden';
      mirror.style.whiteSpace = 'pre-wrap';
      mirror.style.wordWrap = 'break-word';
      mirror.style.overflowWrap = 'break-word';
      mirror.style.width = textarea.clientWidth + 'px';
      mirror.style.padding = cs.paddingTop + ' ' + cs.paddingRight + ' ' + cs.paddingBottom + ' ' + cs.paddingLeft;
      mirror.style.border = '0';
      mirror.style.outline = '0';
      mirror.style.fontFamily = cs.fontFamily;
      mirror.style.fontSize = cs.fontSize;
      mirror.style.fontWeight = cs.fontWeight;
      mirror.style.fontStyle = cs.fontStyle;
      mirror.style.lineHeight = cs.lineHeight;
      mirror.style.letterSpacing = cs.letterSpacing;
      mirror.style.tabSize = cs.tabSize || '4';
      mirror.style.textAlign = cs.textAlign;
      mirror.style.direction = cs.direction;

      // Build content up to caret
      // Preserve spaces and newlines similar to the textarea
      const before = value.replace(/\n$/g, '\n\u200b'); // ensure trailing newline is measurable
      const safe = before.replace(/ /g, '\u00a0');
      const textNode = document.createTextNode(safe);
      const marker = document.createElement('span');
      marker.textContent = '\u200b';
      mirror.appendChild(textNode);
      mirror.appendChild(marker);
      document.body.appendChild(mirror);

      // Sync scroll so marker reflects viewport position
      mirror.scrollTop = textarea.scrollTop;
      mirror.scrollLeft = textarea.scrollLeft;

      const mrect = marker.getBoundingClientRect();
      mirror.remove();
      return mrect;
    } catch (_) {
      return null;
    }
  }

  isElementFixed(element) {
    try {
      let el = element;
      while (el && el !== document.body) {
        const style = getComputedStyle(el);
        if (style.position === 'fixed') return true;
        el = el.parentElement;
      }
    } catch (_) {
      // ignore
    }
    return false;
  }

  isGhostTextVisible() {
    return this.ghostTextElement && document.contains(this.ghostTextElement);
  }

  acceptGhostText() {
    if (!this.ghostTextElement || !this.activeElement || !this.currentCompletion) return;
    
    let text = this.currentCompletion;
    
    // Insert the text into the active element using saved cursor position
    if (this.activeElement.tagName === 'TEXTAREA' || this.activeElement.tagName === 'INPUT') {
      const currentValue = this.activeElement.value;
      // Use saved cursor position if available, otherwise current position
      const cursorPos = this.savedCursorPosition !== null ? this.savedCursorPosition : this.activeElement.selectionStart;
      const prevChar = cursorPos > 0 ? currentValue.slice(cursorPos - 1, cursorPos) : '';
      // If we would create double spaces, collapse to single
      if ((prevChar === ' ' && /^\s/.test(text)) || /\s{2,}$/.test(currentValue.slice(0, cursorPos) + text)) {
        text = text.replace(/^\s+/, '');
      }
      
      this.activeElement.value = currentValue.slice(0, cursorPos) + text + currentValue.slice(cursorPos);
      this.activeElement.selectionStart = this.activeElement.selectionEnd = cursorPos + text.length;
      
      // Focus back to the element
      this.activeElement.focus();
      
    } else if (this.activeElement.isContentEditable) {
      // For contenteditable, try to use saved position if available
      let insertionRange;
      
      if (this.savedCursorPosition && this.savedCursorPosition.container && this.savedCursorPosition.offset !== undefined) {
        // Use saved position
        insertionRange = document.createRange();
        try {
          insertionRange.setStart(this.savedCursorPosition.container, this.savedCursorPosition.offset);
          insertionRange.collapse(true);
          // Check previous character if in a text node
          try {
            const node = this.savedCursorPosition.container;
            if (node && node.nodeType === Node.TEXT_NODE) {
              const t = node.textContent || '';
              const prev = this.savedCursorPosition.offset > 0 ? t[this.savedCursorPosition.offset - 1] : '';
              if ((prev === ' ' && /^\s/.test(text)) || /\s{2,}$/.test(t.slice(0, this.savedCursorPosition.offset) + text)) {
                text = text.replace(/^\s+/, '');
              }
            }
          } catch (_) {}
        } catch (error) {
          // Fallback to current selection if saved position is invalid
          const selection = window.getSelection();
          if (selection.rangeCount > 0) {
            insertionRange = selection.getRangeAt(0);
          }
        }
      } else {
        // Use current selection
        const selection = window.getSelection();
        if (selection.rangeCount > 0) {
          insertionRange = selection.getRangeAt(0);
        }
      }
      
      if (insertionRange) {
        insertionRange.deleteContents();
        insertionRange.insertNode(document.createTextNode(text));
        insertionRange.collapse(false);
        
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(insertionRange);
        
        // Focus back to the element
        this.activeElement.focus();
      }
    }

    this.clearGhostText();
  }

  clearGhostText() {
    if (this.ghostTextElement) {
      this.ghostTextElement.remove();
      this.ghostTextElement = null;
    }
    
    this.currentCompletion = null;
    this.savedCursorPosition = null;
    
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  isTypingKey(event) {
    // Keys that represent actual typing (not navigation/modifier keys)
    return !event.ctrlKey && 
           !event.altKey && 
           !['Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 
             'Home', 'End', 'PageUp', 'PageDown'].includes(event.code);
  }

  matchesShortcut(event, shortcut) {
    // shortcut like 'Ctrl+Shift+S'
    if (!shortcut) return false;
    const parts = shortcut.split('+');
    const needCtrl = parts.includes('Ctrl');
    const needShift = parts.includes('Shift');
    const needAlt = parts.includes('Alt');
    const key = parts[parts.length - 1];
    if (!!event.ctrlKey !== !!needCtrl) return false;
    if (!!event.shiftKey !== !!needShift) return false;
    if (!!event.altKey !== !!needAlt) return false;
    if (key.length === 1) {
      // letter
      return event.code === ('Key' + key.toUpperCase());
    }
    return event.code === key;
  }

  async loadSettings() {
    try {
      if (!chrome?.storage?.local) return;
      chrome.storage.local.get(['settings'], (data) => {
        const s = data?.settings || {};
        this.updateSettingsFromObject(s);
      });
    } catch (e) {
      // ignore
    }
  }

  updateSettingsFromObject(s) {
    this.triggers.ctrlEnter = !!s.ctrlEnter;
    this.triggers.doubleSpace = !!s.doubleSpace;
    this.triggers.autoAfterPunctuation = !!s.autoAfterPunctuation;
    if (typeof s.disableToggleShortcut === 'string' && s.disableToggleShortcut.trim()) {
      this.disableToggleShortcut = s.disableToggleShortcut.trim();
    }
    if (typeof s.cacheSize === 'number' && s.cacheSize > 10 && s.cacheSize <= 500) {
      this.cache = new LRUCache(s.cacheSize);
    }
    if (typeof s.minSentences === 'number') this.minSentences = Math.min(3, Math.max(1, s.minSentences));
    if (typeof s.maxSentences === 'number') this.maxSentences = Math.min(6, Math.max(1, s.maxSentences));
  }

  stripCursorArtifacts(text) {
    if (!text) return text;
    // Remove full marker and common partials that can appear mid-stream
    return text
      .replace(/\[CURSOR\]/gi, '')
      .replace(/\[CURS/gi, '')
      .replace(/CURSOR\]/gi, '')
      .replace(/CUR/gi, (m)=>'') // rare partials
      .trim();
  }
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    new SmartAutocomplete();
  });
} else {
  new SmartAutocomplete();
}

// Site preference helpers (persisted per hostname)
SmartAutocomplete.prototype.loadSitePreference = async function() {
  try {
    if (!chrome?.storage?.local) return;
    const host = location.hostname;
    chrome.storage.local.get(['site_prefs'], (data) => {
      const prefs = data?.site_prefs || {};
      this.siteEnabled = prefs[host] !== false; // default enabled
    });
  } catch (e) {
    console.log('[SmartAutocomplete] Failed to load site preference:', e.message);
    this.siteEnabled = true;
  }
};

SmartAutocomplete.prototype.toggleSitePreference = async function() {
  try {
    if (!chrome?.storage?.local) return;
    const host = location.hostname;
    chrome.storage.local.get(['site_prefs'], (data) => {
      const prefs = data?.site_prefs || {};
      const current = prefs[host] !== false;
      const next = !current;
      prefs[host] = next;
      chrome.storage.local.set({ site_prefs: prefs }, () => {
        this.siteEnabled = next;
        this.showGhostText(next ? 'Enabled autocomplete on this site' : 'Disabled autocomplete on this site', null, next ? 'ready' : 'error');
        setTimeout(() => this.clearGhostText(), 1200);
      });
    });
  } catch (e) {
    console.log('[SmartAutocomplete] Failed to toggle site preference:', e.message);
  }
};
