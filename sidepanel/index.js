/* global LanguageModel */

import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { OpenRouter } from '@openrouter/sdk';

const buttonOrganize = document.body.querySelector('#button-organize');
const buttonStop = document.body.querySelector('#button-stop');
const buttonUngroup = document.body.querySelector('#button-ungroup');
const buttonReset = document.body.querySelector('#button-reset');
const buttonUndo = document.body.querySelector('#button-undo');
const buttonRedo = document.body.querySelector('#button-redo');
const buttonRefresh = document.body.querySelector('#button-refresh');
const buttonSettings = document.body.querySelector('#button-settings');
const elementStatus = document.body.querySelector('#status');
const elementResults = document.body.querySelector('#results');
const elementError = document.body.querySelector('#error');
const customInstructionInput = document.body.querySelector('#custom-instruction');
const tabListElement = document.body.querySelector('#tab-list');
const settingsModal = document.body.querySelector('#settings-modal');
const modalClose = document.body.querySelector('#modal-close');
const modalOverlay = settingsModal?.querySelector('.modal-overlay');
const providerOnDevice = document.body.querySelector('#provider-on-device');
const providerOpenRouter = document.body.querySelector('#provider-openrouter');
const openRouterSettings = document.body.querySelector('#openrouter-settings');
const openRouterApiKeyInput = document.body.querySelector('#openrouter-api-key');

let session;
let currentAbortController = null;
let openRouterClient = null;

// Settings state
let currentSettings = {
  provider: 'on-device',
  openRouterApiKey: ''
};

// History management for undo/redo
let undoStack = [];
let redoStack = [];
const MAX_HISTORY = 20;

// Load settings from storage
async function loadSettings() {
  try {
    const result = await chrome.storage.local.get(['aiProvider', 'openRouterApiKey']);
    if (result.aiProvider) {
      currentSettings.provider = result.aiProvider;
    }
    if (result.openRouterApiKey) {
      currentSettings.openRouterApiKey = result.openRouterApiKey;
    }
    
    // Update UI
    if (currentSettings.provider === 'openrouter') {
      providerOpenRouter.checked = true;
      show(openRouterSettings);
    } else {
      providerOnDevice.checked = true;
      hide(openRouterSettings);
    }
    
    if (currentSettings.openRouterApiKey) {
      openRouterApiKeyInput.value = currentSettings.openRouterApiKey;
    }
    
    // Initialize OpenRouter client if needed
    if (currentSettings.provider === 'openrouter' && currentSettings.openRouterApiKey) {
      initializeOpenRouter();
    }
  } catch (e) {
    console.error('Failed to load settings:', e);
  }
}

// Save settings to storage
async function saveSettings() {
  try {
    await chrome.storage.local.set({
      aiProvider: currentSettings.provider,
      openRouterApiKey: currentSettings.openRouterApiKey
    });
  } catch (e) {
    console.error('Failed to save settings:', e);
  }
}

// Initialize OpenRouter client
function initializeOpenRouter() {
  if (currentSettings.openRouterApiKey) {
    openRouterClient = new OpenRouter({
      apiKey: currentSettings.openRouterApiKey,
      defaultHeaders: {
        'HTTP-Referer': 'https://github.com/tabio-ai',
        'X-Title': 'Tabio AI - Tab Organizer',
      },
    });
  }
}

// Load history from storage
async function loadHistoryFromStorage() {
  try {
    const result = await chrome.storage.local.get(['undoStack', 'redoStack']);
    if (result.undoStack) {
      undoStack = result.undoStack;
    }
    if (result.redoStack) {
      redoStack = result.redoStack;
    }
    updateHistoryButtons();
  } catch (e) {
    console.error('Failed to load history from storage:', e);
  }
}

// Save history to storage
async function saveHistoryToStorage() {
  try {
    await chrome.storage.local.set({
      undoStack: undoStack,
      redoStack: redoStack
    });
  } catch (e) {
    console.error('Failed to save history to storage:', e);
  }
}

const COLORS = ['blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];

const params = {
  temperature: 0.1,
  topK: 1,
  expectedInputs: [
    { type: 'text', languages: ['en'] }
  ],
  expectedOutputs: [
    { type: 'text', languages: ['en'] }
  ]
};

// JSON Schema for structured output
const responseSchema = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      category: {
        type: 'string'
      },
      tabIds: {
        type: 'array',
        items: {
          type: 'number'
        }
      }
    },
    required: ['category', 'tabIds']
  }
};

async function runPrompt(prompt, params, schema = null, signal = null) {
  try {
    if (currentSettings.provider === 'openrouter') {
      return await runOpenRouterPrompt(prompt, schema, signal);
    } else {
      return await runOnDevicePrompt(prompt, params, schema, signal);
    }
  } catch (e) {
    // Check for abort in multiple ways
    if (e.name === 'AbortError' || e.message?.includes('aborted') || signal?.aborted) {
      console.log('Prompt was aborted by user');
      throw new Error('Stopped by user');
    }
    console.log('Prompt failed');
    console.error(e);
    console.log('Prompt:', prompt);
    throw e;
  }
}

async function runOnDevicePrompt(prompt, params, schema = null, signal = null) {
  if (!session) {
    session = await LanguageModel.create(params);
  }
  const options = {};
  if (schema) {
    options.responseConstraint = schema;
  }
  if (signal) {
    options.signal = signal;
  }
  return session.prompt(prompt, options);
}

async function runOpenRouterPrompt(prompt, schema = null, signal = null) {
  if (!openRouterClient) {
    throw new Error('OpenRouter client not initialized. Please check your API key.');
  }

  // Add schema instructions to the prompt if schema is provided
  let enhancedPrompt = prompt;
  if (schema) {
    enhancedPrompt += `\n\nYou MUST respond with valid JSON that is an ARRAY of objects. Each object should have:
- "category": string (the category name)
- "tabIds": array of numbers (the tab IDs in that category)

Example format:
[
  {"category": "Work", "tabIds": [123, 456]},
  {"category": "Shopping", "tabIds": [789]}
]

Respond ONLY with the JSON array, no markdown formatting, no explanation text.`;
  }

  const completion = await openRouterClient.chat.send({
    model: 'google/gemini-2.5-flash-lite',
    messages: [
      {
        role: 'user',
        content: enhancedPrompt,
      },
    ],
    stream: false,
  });

  let responseText = completion.choices[0].message.content;
  
  // Clean up the response - remove markdown code blocks if present
  responseText = responseText.trim();
  if (responseText.startsWith('```json')) {
    responseText = responseText.slice(7); // Remove ```json
  } else if (responseText.startsWith('```')) {
    responseText = responseText.slice(3); // Remove ```
  }
  if (responseText.endsWith('```')) {
    responseText = responseText.slice(0, -3); // Remove trailing ```
  }
  responseText = responseText.trim();
  
  return responseText;
}

async function reset() {
  if (session) {
    session.destroy();
  }
  session = null;
}

// History management functions
async function captureTabGroupState() {
  try {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    const groups = await chrome.tabGroups.query({ windowId: chrome.windows.WINDOW_ID_CURRENT });
    
    // Create a map of group info
    const groupMap = {};
    for (const group of groups) {
      groupMap[group.id] = {
        title: group.title,
        color: group.color,
        collapsed: group.collapsed
      };
    }
    
    // Capture tab info with their group assignments
    const state = tabs.map(tab => ({
      id: tab.id,
      index: tab.index,
      groupId: tab.groupId,
      groupInfo: tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE ? groupMap[tab.groupId] : null
    }));
    
    return state;
  } catch (e) {
    console.error('Failed to capture tab group state:', e);
    return null;
  }
}

async function restoreTabGroupState(state) {
  try {
    if (!state || !Array.isArray(state)) {
      console.error('Invalid state to restore');
      return false;
    }
    
    // First, ungroup all tabs
    const currentTabs = await chrome.tabs.query({ currentWindow: true });
    const groupedTabs = currentTabs.filter(tab => tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE);
    if (groupedTabs.length > 0) {
      await chrome.tabs.ungroup(groupedTabs.map(tab => tab.id));
    }
    
    // Create a map to track which tabs belong to which group config
    const groupConfigs = new Map();
    
    for (const tabState of state) {
      if (tabState.groupInfo) {
        const groupKey = `${tabState.groupInfo.title}_${tabState.groupInfo.color}`;
        if (!groupConfigs.has(groupKey)) {
          groupConfigs.set(groupKey, {
            tabIds: [],
            title: tabState.groupInfo.title,
            color: tabState.groupInfo.color,
            collapsed: tabState.groupInfo.collapsed
          });
        }
        groupConfigs.get(groupKey).tabIds.push(tabState.id);
      }
    }
    
    // Recreate groups
    for (const config of groupConfigs.values()) {
      if (config.tabIds.length > 0) {
        try {
          // Verify tabs still exist
          const validTabIds = [];
          for (const tabId of config.tabIds) {
            try {
              await chrome.tabs.get(tabId);
              validTabIds.push(tabId);
            } catch (e) {
              // Tab doesn't exist anymore, skip it
            }
          }
          
          if (validTabIds.length > 0) {
            const groupId = await chrome.tabs.group({ tabIds: validTabIds });
            await chrome.tabGroups.update(groupId, {
              title: config.title,
              color: config.color,
              collapsed: config.collapsed
            });
          }
        } catch (e) {
          console.error('Failed to restore group:', config.title, e);
        }
      }
    }
    
    return true;
  } catch (e) {
    console.error('Failed to restore tab group state:', e);
    return false;
  }
}

async function saveStateToHistory() {
  const state = await captureTabGroupState();
  if (state) {
    undoStack.push(state);
    // Limit history size
    if (undoStack.length > MAX_HISTORY) {
      undoStack.shift();
    }
    // Clear redo stack when new action is taken
    redoStack = [];
    updateHistoryButtons();
    // Persist to storage
    await saveHistoryToStorage();
  }
}

function updateHistoryButtons() {
  if (undoStack.length > 0) {
    buttonUndo.removeAttribute('disabled');
  } else {
    buttonUndo.setAttribute('disabled', '');
  }
  
  if (redoStack.length > 0) {
    buttonRedo.removeAttribute('disabled');
  } else {
    buttonRedo.setAttribute('disabled', '');
  }
}

async function checkModelAvailability() {
  if (currentSettings.provider === 'on-device') {
    if (!('LanguageModel' in self)) {
      showError('AI Model not available. Please check Chrome flags and download the model.');
      buttonOrganize.setAttribute('disabled', '');
      return;
    }
    buttonOrganize.removeAttribute('disabled');
  } else if (currentSettings.provider === 'openrouter') {
    if (!currentSettings.openRouterApiKey) {
      showError('OpenRouter API key not set. Please add your API key in settings.');
      buttonOrganize.setAttribute('disabled', '');
      return;
    }
    buttonOrganize.removeAttribute('disabled');
  }
}

// Tab list display and drag-drop functionality
let draggedElement = null;
let draggedTabId = null;

async function loadAndDisplayTabs() {
  try {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    const groups = await chrome.tabGroups.query({ windowId: chrome.windows.WINDOW_ID_CURRENT });
    
    // Create group map
    const groupMap = new Map();
    for (const group of groups) {
      groupMap.set(group.id, {
        id: group.id,
        title: group.title || 'Untitled Group',
        color: group.color,
        collapsed: group.collapsed,
        tabs: []
      });
    }
    
    // Add ungrouped category
    groupMap.set(-1, {
      id: -1,
      title: 'Ungrouped',
      color: null,
      tabs: []
    });
    
    // Organize tabs by group
    for (const tab of tabs) {
      // Skip chrome:// and extension pages
      if (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
        continue;
      }
      
      const groupId = tab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE ? -1 : tab.groupId;
      if (groupMap.has(groupId)) {
        groupMap.get(groupId).tabs.push(tab);
      }
    }
    
    // Sort tabs within each group by index
    for (const group of groupMap.values()) {
      group.tabs.sort((a, b) => a.index - b.index);
    }
    
    // Render tab list
    renderTabList(groupMap);
  } catch (e) {
    console.error('Failed to load tabs:', e);
  }
}

function renderTabList(groupMap) {
  tabListElement.innerHTML = '';
  
  let hasAnyTabs = false;
  
  // Sort groups by their first tab's index for consistent ordering
  const sortedGroups = Array.from(groupMap.entries())
    .filter(([_, group]) => group.tabs.length > 0)
    .sort(([_, a], [__, b]) => {
      // Get min index from each group
      const minA = Math.min(...a.tabs.map(t => t.index));
      const minB = Math.min(...b.tabs.map(t => t.index));
      return minA - minB;
    });
  
  // Render each group
  for (const [groupId, group] of sortedGroups) {
    
    hasAnyTabs = true;
    
    const groupElement = document.createElement('div');
    groupElement.className = `tab-group ${groupId === -1 ? 'ungrouped' : ''}`;
    groupElement.dataset.groupId = groupId;
    
    // Group header
    const headerElement = document.createElement('div');
    headerElement.className = 'group-header';
    const isCollapsed = group.collapsed || false;
    headerElement.innerHTML = `
      <div class="group-title">
        ${groupId !== -1 ? `<div class="group-color color-${group.color}"></div>` : ''}
        <span class="group-title-text ${groupId !== -1 ? 'editable' : ''}" contenteditable="${groupId !== -1 ? 'true' : 'false'}" spellcheck="false" data-group-id="${groupId}">${group.title}</span>
      </div>
      <div class="group-actions">
        <span class="group-count">${group.tabs.length} tab${group.tabs.length !== 1 ? 's' : ''}</span>
        ${groupId !== -1 ? `<button class="collapse-btn ${isCollapsed ? 'collapsed' : ''}" data-group-id="${groupId}" title="${isCollapsed ? 'Expand' : 'Collapse'} group"><i class="bi ${isCollapsed ? 'bi-chevron-right' : 'bi-chevron-down'}"></i></button>` : ''}
      </div>
    `;
    
    groupElement.appendChild(headerElement);
    
    // Add title editing listener
    if (groupId !== -1) {
      const titleSpan = headerElement.querySelector('.group-title-text');
      setupTitleEditing(titleSpan, groupId, group.title);
    }
    
    // Add collapse button listener
    if (groupId !== -1) {
      const collapseBtn = headerElement.querySelector('.collapse-btn');
      collapseBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleGroupUICollapse(groupElement, collapseBtn);
      });
    }
    
    // Initially collapse if the group is collapsed
    if (groupId !== -1 && isCollapsed) {
      groupElement.classList.add('ui-collapsed');
    }
    
    // Tabs
    for (const tab of group.tabs) {
      const tabElement = document.createElement('div');
      tabElement.className = 'tab-item';
      tabElement.draggable = true;
      tabElement.dataset.tabId = tab.id;
      tabElement.dataset.groupId = groupId;
      
      const favicon = tab.favIconUrl || '';
      const title = tab.title || 'Untitled';
      const url = new URL(tab.url).hostname;
      
      tabElement.innerHTML = `
        ${favicon ? `<img src="${favicon}" class="tab-favicon" alt="">` : '<div class="tab-favicon placeholder"></div>'}
        <div class="tab-info">
          <div class="tab-title">${escapeHtml(title)}</div>
          <div class="tab-url">${escapeHtml(url)}</div>
        </div>
      `;
      
      // Drag events
      tabElement.addEventListener('dragstart', handleTabDragStart);
      tabElement.addEventListener('dragend', handleTabDragEnd);
      tabElement.addEventListener('dragover', handleTabDragOver);
      tabElement.addEventListener('drop', handleTabDrop);
      tabElement.addEventListener('dragleave', handleTabDragLeave);
      
      groupElement.appendChild(tabElement);
    }
    
    // Group drop events
    groupElement.addEventListener('dragover', handleGroupDragOver);
    groupElement.addEventListener('drop', handleGroupDrop);
    groupElement.addEventListener('dragleave', handleGroupDragLeave);
    
    tabListElement.appendChild(groupElement);
  }
  
  if (!hasAnyTabs) {
    tabListElement.innerHTML = '<div class="empty-state">No tabs to display</div>';
  }
}

function handleTabDragStart(e) {
  draggedElement = e.currentTarget;
  draggedTabId = parseInt(e.currentTarget.dataset.tabId);
  e.currentTarget.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', draggedTabId);
}

function handleTabDragEnd(e) {
  e.currentTarget.classList.remove('dragging');
  // Remove all drag-over classes
  document.querySelectorAll('.drag-over').forEach(el => {
    el.classList.remove('drag-over');
  });
  draggedElement = null;
  draggedTabId = null;
}

function handleTabDragOver(e) {
  if (!draggedElement) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  
  const targetTab = e.currentTarget;
  if (targetTab !== draggedElement && targetTab.classList.contains('tab-item')) {
    targetTab.classList.add('drag-over');
  }
}

function handleTabDragLeave(e) {
  e.currentTarget.classList.remove('drag-over');
}

async function handleTabDrop(e) {
  e.preventDefault();
  e.stopPropagation();
  e.currentTarget.classList.remove('drag-over');
  
  if (!draggedTabId) return;
  
  // Store IDs locally before any async operations
  const localDraggedTabId = draggedTabId;
  const localDraggedGroupId = draggedElement ? parseInt(draggedElement.dataset.groupId) : -1;
  
  const targetTab = e.currentTarget;
  const targetTabId = parseInt(targetTab.dataset.tabId);
  const targetGroupId = parseInt(targetTab.dataset.groupId);
  
  if (targetTabId === localDraggedTabId) return;
  if (isNaN(targetTabId) || isNaN(localDraggedTabId)) return;
  
  try {
    // Save state for undo
    await saveStateToHistory();
    
    // Get tab info using query
    const allTabs = await chrome.tabs.query({});
    const targetTabInfo = allTabs.find(t => t.id === targetTabId);
    const draggedTabInfo = allTabs.find(t => t.id === localDraggedTabId);
    
    if (!targetTabInfo || !draggedTabInfo) return;
    
    // Move dragged tab next to target tab
    await chrome.tabs.move(localDraggedTabId, { 
      index: targetTabInfo.index 
    });
    
    // If target is in a group and dragged tab isn't in that group, add it to the group
    if (targetGroupId !== -1 && draggedTabInfo.groupId !== targetGroupId) {
      await chrome.tabs.group({ tabIds: [localDraggedTabId], groupId: targetGroupId });
    }
    
    // Reload display
    await loadAndDisplayTabs();
  } catch (e) {
    console.error('Failed to move tab:', e);
    showError('Failed to move tab');
  }
}

function handleGroupDragOver(e) {
  if (!draggedElement) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  e.currentTarget.classList.add('drag-over');
}

function handleGroupDragLeave(e) {
  if (e.currentTarget === e.target || !e.currentTarget.contains(e.relatedTarget)) {
    e.currentTarget.classList.remove('drag-over');
  }
}

async function handleGroupDrop(e) {
  e.preventDefault();
  e.stopPropagation();
  e.currentTarget.classList.remove('drag-over');
  
  if (!draggedTabId) return;
  
  // Store IDs locally before any async operations
  const localDraggedTabId = draggedTabId;
  
  const targetGroupId = parseInt(e.currentTarget.dataset.groupId);
  const draggedGroupId = parseInt(draggedElement.dataset.groupId);
  
  if (targetGroupId === draggedGroupId) return;
  
  try {
    // Save state for undo
    await saveStateToHistory();
    
    if (targetGroupId === -1) {
      // Ungroup the tab
      await chrome.tabs.ungroup([localDraggedTabId]);
    } else {
      // Add to target group
      await chrome.tabs.group({ 
        groupId: targetGroupId,
        tabIds: [localDraggedTabId]
      });
    }
    
    // Reload display
    await loadAndDisplayTabs();
  } catch (e) {
    console.error('Failed to move tab to group:', e);
    showError('Failed to move tab to group');
  }
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function toggleGroupUICollapse(groupElement, collapseBtn) {
  const isCollapsed = groupElement.classList.toggle('ui-collapsed');
  
  // Update button icon and state
  const icon = collapseBtn.querySelector('i');
  if (isCollapsed) {
    icon.classList.remove('bi-chevron-down');
    icon.classList.add('bi-chevron-right');
    collapseBtn.classList.add('collapsed');
    collapseBtn.setAttribute('title', 'Expand group');
  } else {
    icon.classList.remove('bi-chevron-right');
    icon.classList.add('bi-chevron-down');
    collapseBtn.classList.remove('collapsed');
    collapseBtn.setAttribute('title', 'Collapse group');
  }
}

function setupTitleEditing(titleElement, groupId, originalTitle) {
  let isEditing = false;
  let previousTitle = originalTitle;
  
  // Click to start editing
  titleElement.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!isEditing) {
      isEditing = true;
      previousTitle = titleElement.textContent;
      titleElement.classList.add('editing');
      // Select all text
      const range = document.createRange();
      range.selectNodeContents(titleElement);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }
  });
  
  // Handle Enter key to save
  titleElement.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      titleElement.blur();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      titleElement.textContent = previousTitle;
      titleElement.blur();
    }
  });
  
  // Save on blur
  titleElement.addEventListener('blur', async () => {
    if (!isEditing) return;
    
    isEditing = false;
    titleElement.classList.remove('editing');
    
    const newTitle = titleElement.textContent.trim();
    
    // Revert if empty
    if (!newTitle) {
      titleElement.textContent = previousTitle;
      return;
    }
    
    // Update if changed
    if (newTitle !== previousTitle) {
      const success = await updateGroupTitle(groupId, newTitle);
      if (!success) {
        titleElement.textContent = previousTitle;
        showError('Failed to update group title');
      }
    }
  });
}

async function updateGroupTitle(groupId, newTitle) {
  try {
    await chrome.tabGroups.update(groupId, {
      title: newTitle
    });
    return true;
  } catch (e) {
    console.error('Failed to update group title:', e);
    return false;
  }
}

// Settings event listeners
providerOnDevice.addEventListener('change', async () => {
  if (providerOnDevice.checked) {
    currentSettings.provider = 'on-device';
    hide(openRouterSettings);
    await saveSettings();
    await checkModelAvailability();
  }
});

providerOpenRouter.addEventListener('change', async () => {
  if (providerOpenRouter.checked) {
    currentSettings.provider = 'openrouter';
    show(openRouterSettings);
    await saveSettings();
    await checkModelAvailability();
  }
});

openRouterApiKeyInput.addEventListener('input', async () => {
  currentSettings.openRouterApiKey = openRouterApiKeyInput.value.trim();
  await saveSettings();
  initializeOpenRouter();
  await checkModelAvailability();
});

// Initialize app
(async function init() {
  // Load settings on init
  await loadSettings();
  
  checkModelAvailability();
  
  // Load history from storage
  loadHistoryFromStorage();
  
  // Load tabs on init
  loadAndDisplayTabs();
})();

// Load custom instruction from localStorage
const savedInstruction = localStorage.getItem('customInstruction');
if (savedInstruction) {
  customInstructionInput.value = savedInstruction;
}

// Save custom instruction when changed
customInstructionInput.addEventListener('input', () => {
  localStorage.setItem('customInstruction', customInstructionInput.value);
});

buttonReset.addEventListener('click', () => {
  reset();
});

buttonOrganize.addEventListener('click', async () => {
  await organizeTabsWithAI();
});

buttonStop.addEventListener('click', () => {
  if (currentAbortController) {
    currentAbortController.abort();
    currentAbortController = null;
    // Reset session as it may be in a bad state
    reset();
    hide(buttonStop);
    show(buttonOrganize);
    buttonOrganize.removeAttribute('disabled');
  }
});

buttonUngroup.addEventListener('click', async () => {
  await ungroupAllTabs();
});

buttonRefresh.addEventListener('click', async () => {
  await loadAndDisplayTabs();
});

buttonSettings.addEventListener('click', () => {
  show(settingsModal);
});

modalClose.addEventListener('click', () => {
  hide(settingsModal);
});

modalOverlay.addEventListener('click', () => {
  hide(settingsModal);
});

buttonUndo.addEventListener('click', async () => {
  if (undoStack.length === 0) return;
  
  try {
    // Save current state to redo stack
    const currentState = await captureTabGroupState();
    if (currentState) {
      redoStack.push(currentState);
    }
    
    // Restore previous state
    const previousState = undoStack.pop();
    const success = await restoreTabGroupState(previousState);
    
    if (success) {
      updateHistoryButtons();
      await saveHistoryToStorage();
      await loadAndDisplayTabs();
    } else {
      showError('Failed to undo');
      // Put state back if restore failed
      if (currentState) {
        undoStack.push(previousState);
        redoStack.pop();
      }
    }
  } catch (e) {
    console.error('Undo failed:', e);
    showError('Failed to undo');
  }
});

buttonRedo.addEventListener('click', async () => {
  if (redoStack.length === 0) return;
  
  try {
    // Save current state to undo stack
    const currentState = await captureTabGroupState();
    if (currentState) {
      undoStack.push(currentState);
    }
    
    // Restore next state
    const nextState = redoStack.pop();
    const success = await restoreTabGroupState(nextState);
    
    if (success) {
      updateHistoryButtons();
      await saveHistoryToStorage();
      await loadAndDisplayTabs();
    } else {
      showError('Failed to redo');
      // Put state back if restore failed
      if (currentState) {
        redoStack.push(nextState);
        undoStack.pop();
      }
    }
  } catch (e) {
    console.error('Redo failed:', e);
    showError('Failed to redo');
  }
});

async function organizeTabsWithAI() {
  try {
    buttonOrganize.setAttribute('disabled', '');
    hide(buttonOrganize);
    show(buttonStop);
    buttonStop.classList.add('processing');
    
    // Create new AbortController for this request
    currentAbortController = new AbortController();
    
    // Save current state for undo
    await saveStateToHistory();
    
    // Get all tabs in current window
    const tabs = await chrome.tabs.query({ currentWindow: true });
    
    if (tabs.length === 0) {
      showError('No tabs found to organize.');
      buttonOrganize.removeAttribute('disabled');
      hide(buttonStop);
      currentAbortController = null;
      return;
    }

    console.log('tabs', tabs );
    
    // Prepare tab info for AI (exclude chrome:// and extension pages)
    const tabInfo = tabs
      .filter(tab => !tab.url.startsWith('chrome://') && !tab.url.startsWith('chrome-extension://'))
      .map(tab => ({
        id: tab.id,
        title: tab.title || 'Untitled',
        url: tab.url
      }));
    
    if (tabInfo.length === 0) {
      showError('No regular tabs found to organize (only Chrome internal pages).');
      buttonOrganize.removeAttribute('disabled');
      hide(buttonStop);
      currentAbortController = null;
      return;
    }
    
    // Create AI prompt
    const customInstruction = customInstructionInput.value.trim();
    let prompt = `You are a tab organization assistant. Analyze these browser tabs and group them into logical categories.

Rules:
- Create categories based on the content/purpose of the tabs
- Use clear, concise category names (max 20 chars)
- Each category name must be UNIQUE
- Every tab ID in the input MUST appear in the output, in EXACTLY ONE category
- Do NOT invent any new tab IDs that are not in the input
- Use category names like: Work, Shopping, Social Media, News, Entertainment, Research, Development, Education, or similar`;

    if (customInstruction) {
      prompt += `\n\nAdditional Instructions:\n${customInstruction}`;
    }

    prompt += `\n\nTabs to organize:\n${JSON.stringify(tabInfo, null, 2)}`;

    console.log('prompt', prompt);
    
    let response;
    try {
      response = await runPrompt(prompt, params, responseSchema, currentAbortController.signal);
    } catch (e) {
      // If aborted, just return early - stop button already handled UI
      if (e.message === 'Stopped by user' || e.name === 'AbortError' || e.message?.includes('aborted')) {
        console.log('Operation aborted by user');
        return;
      }
      // Re-throw other errors
      throw e;
    }
    
    console.log('AI Response:', response);
    
    // Parse AI response - with structured output, this should always be valid JSON
    let categories;
    try {
      let parsed = JSON.parse(response);
      console.log('Parsed response:', parsed);
      
      // Handle case where model returns schema wrapper: { "type": "array", "items": [...] }
      if (parsed.items && Array.isArray(parsed.items)) {
        categories = parsed.items;
        console.log('Extracted items array from schema wrapper');
      } else if (Array.isArray(parsed)) {
        categories = parsed;
      } else {
        console.error('Unexpected response structure:', parsed);
        throw new Error('Response is neither an array nor has an items property');
      }
      
      console.log('Final categories array:', categories);
    } catch (e) {
      console.error('Failed to parse AI response:', e);
      console.error('Response was:', response);
      showError('AI returned invalid format. Please try again.');
      buttonOrganize.removeAttribute('disabled');
      hide(buttonStop);
      currentAbortController = null;
      return;
    }

    categories = normalizeCategories(categories, tabInfo);

    if (!categories.length) {
      showError('AI returned no usable categories. Please try again.');
      buttonOrganize.removeAttribute('disabled');
      hide(buttonStop);
      currentAbortController = null;
      return;
    }
    
    // Create tab groups
    let groupCount = 0;
    const results = [];
    
    for (let i = 0; i < categories.length; i++) {
      const category = categories[i];
      
      if (!category.tabIds || category.tabIds.length === 0) {
        continue;
      }
      
      // Filter out any invalid tab IDs
      const validTabIds = category.tabIds.filter(id => 
        tabInfo.some(tab => tab.id === id)
      );
      
      if (validTabIds.length === 0) {
        continue;
      }
      
      try {
        // Create tab group
        const groupId = await chrome.tabs.group({
          tabIds: validTabIds
        });
        
        // Update group with title and color
        await chrome.tabGroups.update(groupId, {
          title: category.category,
          color: COLORS[i % COLORS.length]
        });
        
        groupCount++;
        results.push(`✓ <strong>${category.category}</strong>: ${validTabIds.length} tabs`);
      } catch (e) {
        console.error('Failed to create group:', category.category, e);
      }
    }
    
    if (groupCount === 0) {
      showError('Failed to create any tab groups. Please try again.');
    } else {
      // Just reload tab list to show new organization
      await loadAndDisplayTabs();
    }
    
  } catch (e) {
    console.error('Error organizing tabs:', e);
    showError(`Error: ${e.message || 'Failed to organize tabs'}`);
  } finally {
    currentAbortController = null;
    buttonOrganize.removeAttribute('disabled');
    buttonStop.classList.remove('processing');
    hide(buttonStop);
    show(buttonOrganize);
  }
}

async function ungroupAllTabs() {
  try {
    buttonUngroup.setAttribute('disabled', '');
    
    const tabs = await chrome.tabs.query({ currentWindow: true });
    const groupedTabs = tabs.filter(tab => tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE);
    
    if (groupedTabs.length === 0) {
      buttonUngroup.removeAttribute('disabled');
      return;
    }
    
    // Save current state for undo
    await saveStateToHistory();
    
    await chrome.tabs.ungroup(groupedTabs.map(tab => tab.id));
    
    // Reload tab list
    await loadAndDisplayTabs();
    
  } catch (e) {
    console.error('Error ungrouping tabs:', e);
    showError(`Error: ${e.message || 'Failed to ungroup tabs'}`);
  } finally {
    buttonUngroup.removeAttribute('disabled');
  }
}

function showResults(html) {
  hide(elementError);
  hide(elementStatus);
  show(elementResults);
  elementResults.innerHTML = DOMPurify.sanitize(html);
}

function showError(message) {
  hide(elementResults);
  hide(elementStatus);
  show(elementError);
  elementError.textContent = message;
}

function showStatus(message) {
  hide(elementResults);
  hide(elementError);
  show(elementStatus);
  elementStatus.innerHTML = `<p>${DOMPurify.sanitize(message)}</p>`;
}

function show(element) {
  element.removeAttribute('hidden');
}

function hide(element) {
  element.setAttribute('hidden', '');
}

function normalizeCategories(rawCategories, tabInfo) {
  const knownIds = new Set(tabInfo.map(t => t.id));
  const assigned = new Set();
  const catMap = new Map();

  // 1. Merge duplicate category names, filter invalid & duplicate tabIds
  for (const entry of rawCategories || []) {
    if (!entry || !Array.isArray(entry.tabIds)) continue;
    let name = entry.category || 'Other';

    // Enforce max length, basic cleanup
    name = String(name).trim().slice(0, 20) || 'Other';

    if (!catMap.has(name)) catMap.set(name, []);
    const bucket = catMap.get(name);

    for (const id of entry.tabIds) {
      if (!knownIds.has(id)) continue;          // ignore unknown IDs
      if (assigned.has(id)) continue;           // avoid duplicates across cats
      bucket.push(id);
      assigned.add(id);
    }
  }

  // 2. Add any unassigned tabs into a catch-all category
  const unassigned = tabInfo
    .map(t => t.id)
    .filter(id => !assigned.has(id));

  if (unassigned.length) {
    const miscName = catMap.has('Other') ? 'Other' : 'Misc';
    const bucket = catMap.get(miscName) || [];
    bucket.push(...unassigned);
    catMap.set(miscName, bucket);
  }

  // 3. Convert back to array and drop empty categories
  let categories = [...catMap.entries()]
    .map(([category, tabIds]) => ({ category, tabIds }))
    .filter(c => c.tabIds && c.tabIds.length > 0);

  // 4. Enforce 3-7 category count
  if (categories.length > 7) {
    // Merge smallest ones into "Other"
    categories.sort((a, b) => b.tabIds.length - a.tabIds.length);
    const keep = categories.slice(0, 6);
    const mergedTabs = categories.slice(6).flatMap(c => c.tabIds);
    if (mergedTabs.length) {
      let other = keep.find(c => c.category === 'Other' || c.category === 'Misc');
      if (!other) {
        other = { category: 'Other', tabIds: [] };
        keep.push(other);
      }
      other.tabIds.push(...mergedTabs);
    }
    categories = keep;
  } else if (categories.length < 3 && categories.length > 0) {
    // Optional: split large categories to reach 3 groups.
    // Simple strategy: split the largest category into two.
    while (categories.length < 3) {
      const largestIdx = categories.reduce(
        (bestIdx, c, i, arr) => c.tabIds.length > arr[bestIdx].tabIds.length ? i : bestIdx,
        0
      );
      const largest = categories[largestIdx];
      if (largest.tabIds.length <= 1) break;

      const half = Math.ceil(largest.tabIds.length / 2);
      const newTabs = largest.tabIds.splice(half);
      categories.push({
        category: largest.category + ' 2',
        tabIds: newTabs
      });
    }
  }

  return categories;
}

