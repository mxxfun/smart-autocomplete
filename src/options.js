function getEl(id){return document.getElementById(id)}

function loadSettings(){
  try{
    chrome.storage.local.get(['settings','site_prefs'], (data)=>{
      const s = data?.settings || {};
      getEl('ctrlEnter').checked = !!s.ctrlEnter;
      getEl('doubleSpace').checked = !!s.doubleSpace;
      getEl('autoAfterPunctuation').checked = !!s.autoAfterPunctuation;
      getEl('disableToggleShortcut').value = s.disableToggleShortcut || 'Ctrl+Shift+S';
      getEl('cacheSize').value = s.cacheSize || 60;
      if (getEl('minSentences')) {
        getEl('minSentences').value = s.minSentences || 1;
        getEl('minSentencesVal').textContent = (s.minSentences || 1);
      }
      if (getEl('maxSentences')) {
        getEl('maxSentences').value = s.maxSentences || 3;
        getEl('maxSentencesVal').textContent = (s.maxSentences || 3);
      }
      renderDisabledSites(data?.site_prefs || {});
    });
  }catch(e){/* ignore */}
}

function saveSettings(){
  const s = {
    ctrlEnter: getEl('ctrlEnter').checked,
    doubleSpace: getEl('doubleSpace').checked,
    autoAfterPunctuation: getEl('autoAfterPunctuation').checked,
    disableToggleShortcut: getEl('disableToggleShortcut').value.trim() || 'Ctrl+Shift+S',
    cacheSize: Math.min(500, Math.max(10, parseInt(getEl('cacheSize').value||'60',10))),
    minSentences: Math.min(3, Math.max(1, parseInt((getEl('minSentences')?.value)||'1', 10))),
    maxSentences: Math.min(6, Math.max(1, parseInt((getEl('maxSentences')?.value)||'3', 10)))
  };
  chrome.storage.local.set({ settings: s }, ()=>{
    const status = getEl('status');
    status.textContent = 'Saved!';
    setTimeout(()=>status.textContent='', 1200);
  });
}

function renderDisabledSites(prefs){
  const ul = getEl('disabledSites');
  ul.innerHTML='';
  const entries = Object.entries(prefs).filter(([host, enabled])=>enabled===false);
  if(entries.length===0){
    const li = document.createElement('li');
    li.textContent = 'No disabled sites';
    ul.appendChild(li);
    return;
  }
  for(const [host] of entries){
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.textContent = `Enable ${host}`;
    btn.onclick = ()=>{
      chrome.storage.local.get(['site_prefs'], (data)=>{
        const prefs = data?.site_prefs || {};
        prefs[host] = true;
        chrome.storage.local.set({ site_prefs: prefs }, ()=> loadSettings());
      });
    };
    li.appendChild(btn);
    ul.appendChild(li);
  }
}

document.addEventListener('DOMContentLoaded', ()=>{
  loadSettings();
  getEl('save').addEventListener('click', saveSettings);
  getEl('refreshSites').addEventListener('click', loadSettings);
  const minEl = getEl('minSentences');
  const maxEl = getEl('maxSentences');
  if (minEl) {
    minEl.addEventListener('input', ()=>{
      getEl('minSentencesVal').textContent = minEl.value;
    });
  }
  if (maxEl) {
    maxEl.addEventListener('input', ()=>{
      getEl('maxSentencesVal').textContent = maxEl.value;
    });
  }
});


