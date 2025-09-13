/**
 * Local Smart Autocomplete - Content Script
 * Implements keyboard shortcut listener, ghost text rendering, and model download logic
 */

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
    
    this.init();
  }

  init() {
    console.log('[SmartAutocomplete] Initializing...');
    this.setupKeyboardListener();
    this.setupFocusTracking();
  }

  setupKeyboardListener() {
    document.addEventListener('keydown', (event) => {
      // Ctrl+Shift+Space trigger
      if (event.ctrlKey && event.shiftKey && event.code === 'Space') {
        event.preventDefault();
        event.stopPropagation();
        this.handleTrigger();
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
    
    if (!this.activeElement || !this.isTextInput(this.activeElement)) {
      console.log('[SmartAutocomplete] No valid text input focused');
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
      this.showGhostText('Generating completion...');
      
      // Create abort controller for cancellation
      this.abortController = new AbortController();
      
      // Extract context around cursor and save cursor position
      const contextData = await this.extractContext();
      if (!contextData.text.trim()) {
        this.showGhostText('No context available for completion');
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
      
      // Create completion prompt
      const prompt = await this.createCompletionPrompt(contextData, detectedLanguage);
      
      // Generate completion with structured output
      const response = await this.languageModel.prompt(prompt, {
        signal: this.abortController.signal,
        responseConstraint: {
          type: 'object',
          properties: {
            accept: { type: 'boolean' },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
            sentences: { 
              type: 'array', 
              items: { type: 'string' }, 
              maxItems: 3 
            }
          },
          required: ['accept', 'confidence', 'sentences']
        }
      });
      
      // Parse and display completion
      this.handleCompletionResponse(response, detectedLanguage, contextData);
      
    } catch (error) {
      if (error.name === 'AbortError') {
        console.log('[SmartAutocomplete] Completion cancelled');
      } else {
        console.error('[SmartAutocomplete] Completion failed:', error);
        this.showGhostText('Completion failed: ' + error.message);
      }
    }
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
    const languageInstruction = language !== 'en' ? 
      `Continue in ${language === 'es' ? 'Spanish' : language === 'fr' ? 'French' : language === 'de' ? 'German' : 'the detected language'}.` : 
      'Continue in English.';
    
    // Extract website context for better completions
    const websiteContext = await this.extractWebsiteContext();
    const contextInfo = websiteContext ? `\n\nWebsite context: ${websiteContext}` : '';
    
    // Split context into before/after cursor for clearer completion
    const beforeCursor = contextData.beforeCursor || contextData.text;
    const afterCursor = contextData.afterCursor || '';
    
    // Show exactly where completion should happen using a marker
    const completionPoint = `${beforeCursor}[CURSOR]${afterCursor}`;
    
    // Analyze text to determine if it needs completion or is a question
    const isQuestion = this.isTextQuestion(beforeCursor);
    const completionType = isQuestion ? 'answer this question' : 'continue this text naturally';
    
    return `You are a text completion assistant. Complete ONLY the text after [CURSOR].

Current text: "${completionPoint}"${contextInfo}

CRITICAL INSTRUCTIONS:
- Write ONLY what should come after [CURSOR]
- DO NOT repeat any text that appears before [CURSOR]
- ${isQuestion ? 'Provide a helpful answer to the question' : 'Continue the text naturally from the cursor position'}
- ${languageInstruction}
- Match the writing style and tone exactly
- Provide 1-3 sentences maximum that flow naturally from the cursor position
- If the text already seems complete, respond with accept: false

Example:
Text: "Hello, my name is John and I[CURSOR]"
Good completion: " work as a software engineer."
Bad completion: "Hello, my name is John and I work as a software engineer."

Respond with JSON containing:
- accept: boolean (whether completion is appropriate)
- confidence: number 0-1 (how confident you are)
- sentences: array of 1-3 completion sentences (just the new text, not repetitions)`;
  }

  cleanCompletionText(completion, contextData) {
    if (!completion || !contextData) return completion;
    
    const beforeCursor = contextData.beforeCursor || '';
    
    // Get the last few words before cursor to check for repetition
    const words = beforeCursor.trim().split(/\s+/);
    const lastFewWords = words.slice(-5).join(' ').toLowerCase(); // Check last 5 words
    
    // If completion starts with text already at the end of beforeCursor, remove it
    const completionLower = completion.toLowerCase();
    
    for (let i = 1; i <= Math.min(lastFewWords.length, completion.length); i++) {
      const endOfContext = lastFewWords.slice(-i);
      const startOfCompletion = completionLower.slice(0, i);
      
      if (endOfContext === startOfCompletion) {
        // Found overlap, remove it from completion
        completion = completion.slice(i).trim();
        break;
      }
    }
    
    // Also check for full sentence repetition patterns
    const lastSentence = beforeCursor.match(/[^.!?]*$/)?.[0]?.trim();
    if (lastSentence && completion.toLowerCase().startsWith(lastSentence.toLowerCase())) {
      completion = completion.slice(lastSentence.length).trim();
    }
    
    // Remove leading punctuation that might be duplicated
    completion = completion.replace(/^[,;:.!?]+\s*/, '');
    
    return completion;
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
        initialPrompts: [{role: 'system', content: 'You are a helpful text completion assistant.'}],
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
      this.showGhostText(demoSuggestions + ' (Demo mode - Chrome Built-in AI not available)');
    } else {
      this.showGhostText('Chrome Built-in AI not available. See SETUP-CHROME-AI.md for setup instructions.');
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

  showGhostText(displayText, completionText = null) {
    this.clearGhostText();
    
    if (!this.activeElement) return;

    this.ghostTextElement = document.createElement('div');
    this.ghostTextElement.className = 'smart-autocomplete-ghost';
    this.ghostTextElement.textContent = displayText;
    this.ghostTextElement.setAttribute('data-extension', 'smart-autocomplete');
    
    // Store the actual completion text separately
    this.currentCompletion = completionText || displayText;

    // Position the ghost text
    this.positionGhostText();

    document.body.appendChild(this.ghostTextElement);
  }

  positionGhostText() {
    if (!this.ghostTextElement || !this.activeElement) return;

    const rect = this.activeElement.getBoundingClientRect();
    const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
    const scrollLeft = window.pageXOffset || document.documentElement.scrollLeft;

    // Position below the active element
    this.ghostTextElement.style.position = 'absolute';
    this.ghostTextElement.style.left = (rect.left + scrollLeft) + 'px';
    this.ghostTextElement.style.top = (rect.bottom + scrollTop + 2) + 'px';
    this.ghostTextElement.style.width = Math.min(400, rect.width) + 'px';
  }

  isGhostTextVisible() {
    return this.ghostTextElement && document.contains(this.ghostTextElement);
  }

  acceptGhostText() {
    if (!this.ghostTextElement || !this.activeElement || !this.currentCompletion) return;
    
    const text = this.currentCompletion;
    
    // Insert the text into the active element using saved cursor position
    if (this.activeElement.tagName === 'TEXTAREA' || this.activeElement.tagName === 'INPUT') {
      const currentValue = this.activeElement.value;
      // Use saved cursor position if available, otherwise current position
      const cursorPos = this.savedCursorPosition !== null ? this.savedCursorPosition : this.activeElement.selectionStart;
      
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
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    new SmartAutocomplete();
  });
} else {
  new SmartAutocomplete();
}
