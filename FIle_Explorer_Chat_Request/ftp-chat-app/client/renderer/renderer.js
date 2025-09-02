// Global application state
let appState = {
    config: null,
    ftpConnected: false,
    chatConnected: false,
    currentChatUsername: null,
    activeTab: 'ftp',
    ftpStructure: null,
    selectedFtpPath: null,
    userList: []
};

// DOM element references
const elements = {
    // Modal elements
    configModal: document.getElementById('configModal'),
    configForm: document.getElementById('configForm'),
    mainApp: document.getElementById('mainApp'),
    
    // Status elements
    ftpStatus: document.getElementById('ftpStatus'),
    chatStatus: document.getElementById('chatStatus'),
    
    // Tab elements
    tabButtons: document.querySelectorAll('.tab-button'),
    ftpTab: document.getElementById('ftpTab'),
    chatTab: document.getElementById('chatTab'),
    
    // FTP elements
    ftpTree: document.getElementById('ftpTree'),
    ftpFileList: document.getElementById('ftpFileList'),
    ftpBreadcrumb: document.getElementById('ftpBreadcrumb'),
    ftpLoading: document.getElementById('ftpLoading'),
    ftpEmpty: document.getElementById('ftpEmpty'),
    
    // Chat elements
    chatMessages: document.getElementById('chatMessages'),
    messageInput: document.getElementById('messageInput'),
    sendButton: document.getElementById('sendButton'),
    userList: document.getElementById('userList'),
    userCount: document.getElementById('userCount'),
    chatConnectionStatus: document.getElementById('chatConnectionStatus'),
    
    // Notification elements
    notification: document.getElementById('notification'),
    notificationText: document.getElementById('notificationText'),
    notificationClose: document.getElementById('notificationClose'),
    loadingOverlay: document.getElementById('loadingOverlay'),
    loadingText: document.getElementById('loadingText')
};

// Initialize application
document.addEventListener('DOMContentLoaded', async function() {
    console.log('=== DOM CONTENT LOADED - INITIALIZING APPLICATION ===');
    
    try {
        // Setup event listeners
        setupEventListeners();
        
        // Load existing configuration
        await loadConfiguration();
        
        // Check if configuration is complete
        console.log('=== CONFIGURATION CHECK ===');
        console.log('Loaded configuration:', JSON.stringify(appState.config, null, 2));
        const hasValidConfig = appState.config && 
                              appState.config.ftp && appState.config.ftp.host &&
                              appState.config.chat && appState.config.chat.username;
        
        console.log('Has valid config:', hasValidConfig);
        console.log('FTP config exists:', !!(appState.config && appState.config.ftp));
        console.log('FTP host exists:', !!(appState.config && appState.config.ftp && appState.config.ftp.host));
        console.log('Chat config exists:', !!(appState.config && appState.config.chat));
        console.log('Chat username exists:', !!(appState.config && appState.config.chat && appState.config.chat.username));
        
        if (hasValidConfig) {
            // Hide config modal and show main app
            console.log('Valid config found, initializing connections...');
            hideConfigModal();
            await initializeConnections();
        } else {
            // Show configuration modal
            console.log('Invalid or missing config, showing config modal');
            showConfigModal();
        }
        
        console.log('Application initialized successfully');
        
    } catch (error) {
        console.error('Error initializing application:', error);
        showNotification('Error initializing application: ' + error.message, 'error');
    }
});

// Setup all event listeners
function setupEventListeners() {
    // Configuration form events
    elements.configForm.addEventListener('submit', handleConfigSubmit);
    document.getElementById('cancelConfig').addEventListener('click', hideConfigModal);
    document.getElementById('testFtpButton').addEventListener('click', testFTPConnection);
    document.getElementById('testChatButton').addEventListener('click', testChatConnection);
    
    // Header button events
    document.getElementById('settingsButton').addEventListener('click', showConfigModal);
    document.getElementById('refreshButton').addEventListener('click', refreshAll);
    document.getElementById('refreshFtpButton').addEventListener('click', refreshFTPCache);
    
    // Tab navigation events
    elements.tabButtons.forEach(button => {
        button.addEventListener('click', () => switchTab(button.dataset.tab));
    });
    
    // Chat events
    elements.sendButton.addEventListener('click', sendChatMessage);
    elements.messageInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            sendChatMessage();
        }
    });
    
    // Notification close event
    elements.notificationClose.addEventListener('click', hideNotification);
    
    // Chat input typing indicator
    let typingTimer;
    elements.messageInput.addEventListener('input', () => {
        if (appState.chatConnected) {
            clearTimeout(typingTimer);
            // Send typing start
            electronAPI.chat.sendTypingIndicator?.(true);
            
            typingTimer = setTimeout(() => {
                // Send typing stop
                electronAPI.chat.sendTypingIndicator?.(false);
            }, 1000);
        }
    });
    
    // Chat event listeners
    if (window.electronAPI && window.electronAPI.chat) {
        electronAPI.chat.onMessageReceived(handleChatMessage);
        electronAPI.chat.onUserListUpdated(handleUserListUpdate);
        electronAPI.chat.onError(handleChatError);
    }
}

// Configuration management
async function loadConfiguration() {
    try {
        const config = await electronAPI.config.get();
        appState.config = config;
        
        if (config) {
            populateConfigForm(config);
        }
        
        console.log('Configuration loaded:', config ? 'Found' : 'Not found');
    } catch (error) {
        console.error('Error loading configuration:', error);
        appState.config = null;
    }
}

function populateConfigForm(config) {
    if (config.ftp) {
        document.getElementById('ftpHost').value = config.ftp.host || '';
        document.getElementById('ftpPort').value = config.ftp.port || 21;
        document.getElementById('ftpUsername').value = config.ftp.username || '';
        document.getElementById('ftpPassword').value = config.ftp.password || '';
        document.getElementById('ftpSecure').checked = config.ftp.secure || false;
    }
    
    if (config.chat) {
        document.getElementById('chatServerUrl').value = config.chat.serverUrl || 'ws://localhost:3000';
        document.getElementById('chatUsername').value = config.chat.username || '';
    }
}

async function handleConfigSubmit(event) {
    event.preventDefault();
    
    showLoading('Menyimpan konfigurasi...');
    
    try {
        // Clear previous errors
        clearFormErrors();
        
        // Get form data
        const formData = new FormData(event.target);
        const newConfig = {
            ftp: {
                host: formData.get('ftpHost').trim(),
                port: parseInt(formData.get('ftpPort')),
                username: formData.get('ftpUsername').trim(),
                password: formData.get('ftpPassword'),
                secure: formData.has('ftpSecure')
            },
            chat: {
                serverUrl: formData.get('chatServerUrl').trim(),
                username: formData.get('chatUsername').trim()
            }
        };
        
        // Basic validation
        if (!newConfig.ftp.host) {
            showFieldError('ftpHostError', 'Host FTP harus diisi');
            return;
        }
        
        if (!newConfig.ftp.username) {
            showFieldError('ftpUsernameError', 'Username FTP harus diisi');
            return;
        }
        
        if (!newConfig.ftp.password) {
            showFieldError('ftpPasswordError', 'Password FTP harus diisi');
            return;
        }
        
        if (!newConfig.chat.serverUrl) {
            showFieldError('chatServerUrlError', 'URL Server Chat harus diisi');
            return;
        }
        
        if (!newConfig.chat.username) {
            showFieldError('chatUsernameError', 'Username Chat harus diisi');
            return;
        }
        
        // Save configuration
        const result = await electronAPI.config.save(newConfig);
        
        if (result.success) {
            appState.config = newConfig;
            hideConfigModal();
            showNotification('Konfigurasi berhasil disimpan!', 'success');
            
            // Initialize connections
            await initializeConnections();
        } else {
            throw new Error(result.error || 'Gagal menyimpan konfigurasi');
        }
        
    } catch (error) {
        console.error('Error saving configuration:', error);
        showNotification('Error: ' + error.message, 'error');
    } finally {
        hideLoading();
    }
}

async function testFTPConnection() {
    const button = document.getElementById('testFtpButton');
    const resultDiv = document.getElementById('ftpTestResult');
    
    button.disabled = true;
    button.textContent = 'Testing...';
    resultDiv.className = 'test-result';
    resultDiv.textContent = 'Menguji koneksi FTP...';
    
    try {
        const ftpConfig = {
            host: document.getElementById('ftpHost').value.trim(),
            port: parseInt(document.getElementById('ftpPort').value),
            username: document.getElementById('ftpUsername').value.trim(),
            password: document.getElementById('ftpPassword').value,
            secure: document.getElementById('ftpSecure').checked
        };
        
        const result = await electronAPI.config.validateFTP(ftpConfig);
        
        if (result.success) {
            resultDiv.className = 'test-result success';
            resultDiv.textContent = `✅ ${result.result.message}`;
        } else {
            resultDiv.className = 'test-result error';
            resultDiv.textContent = `❌ ${result.error}`;
        }
        
    } catch (error) {
        resultDiv.className = 'test-result error';
        resultDiv.textContent = `❌ ${error.message}`;
    } finally {
        button.disabled = false;
        button.textContent = 'Test Koneksi FTP';
    }
}

async function testChatConnection() {
    const button = document.getElementById('testChatButton');
    const resultDiv = document.getElementById('chatTestResult');
    
    button.disabled = true;
    button.textContent = 'Testing...';
    resultDiv.className = 'test-result';
    resultDiv.textContent = 'Menguji koneksi Chat...';
    
    try {
        const chatConfig = {
            serverUrl: document.getElementById('chatServerUrl').value.trim(),
            username: document.getElementById('chatUsername').value.trim()
        };
        
        const result = await electronAPI.config.validateChat(chatConfig);
        
        if (result.success) {
            resultDiv.className = 'test-result success';
            resultDiv.textContent = `✅ ${result.result.message}`;
        } else {
            resultDiv.className = 'test-result error';
            resultDiv.textContent = `❌ ${result.error}`;
        }
        
    } catch (error) {
        resultDiv.className = 'test-result error';
        resultDiv.textContent = `❌ ${error.message}`;
    } finally {
        button.disabled = false;
        button.textContent = 'Test Koneksi Chat';
    }
}

// Connection management
async function initializeConnections() {
    showLoading('Menginisialisasi koneksi...');
    
    try {
        // Initialize FTP connection and load cache
        await initializeFTP();
        
        // Initialize Chat connection
        await initializeChat();
        
        showNotification('Aplikasi siap digunakan!', 'success');
        
    } catch (error) {
        console.error('Error initializing connections:', error);
        showNotification('Error menginisialisasi koneksi: ' + error.message, 'error');
    } finally {
        hideLoading();
    }
}

async function initializeFTP() {
    try {
        console.log('Initializing FTP...');
        // Try to get cached structure first
        const cacheResult = await electronAPI.ftp.getCache();
        
        console.log('Cache result:', cacheResult);
        
        if (cacheResult.success && cacheResult.cache) {
            console.log('Cache structure:', cacheResult.cache.structure);
            console.log('About to call renderFTPTree with structure:', JSON.stringify(cacheResult.cache.structure, null, 2));
            appState.ftpStructure = cacheResult.cache.structure;
            renderFTPTree(appState.ftpStructure);
            updateFTPStatus(true);
            console.log('FTP cache loaded successfully');
        } else {
            console.log('No cache found, refreshing...');
            // No cache, try to refresh
            await refreshFTPCache();
        }
        
    } catch (error) {
        console.error('Error initializing FTP:', error);
        updateFTPStatus(false);
        showFTPError('Gagal memuat data FTP: ' + error.message);
    }
}

async function initializeChat() {
    if (!appState.config || !appState.config.chat || !appState.config.chat.username) {
        console.log('Chat configuration not available');
        return;
    }
    
    try {
        const result = await electronAPI.chat.connect(appState.config.chat.username);
        
        if (result.success) {
            appState.chatConnected = true;
            appState.currentChatUsername = result.username;
            updateChatStatus(true);
            enableChatInput();
            console.log('Chat connected successfully');
        } else {
            throw new Error(result.error || 'Failed to connect to chat');
        }
        
    } catch (error) {
        console.error('Error initializing chat:', error);
        appState.chatConnected = false;
        updateChatStatus(false);
        showChatError('Gagal terhubung ke chat: ' + error.message);
    }
}

// FTP functions
async function refreshFTPCache() {
    showLoading('Memuat ulang cache FTP...');
    
    try {
        const result = await electronAPI.ftp.refreshCache();
        
        if (result.success) {
            // Get the updated cache
            const cacheResult = await electronAPI.ftp.getCache();
            
            if (cacheResult.success) {
                appState.ftpStructure = cacheResult.cache.structure;
                renderFTPTree(appState.ftpStructure);
                updateFTPStatus(true);
                showNotification('Cache FTP berhasil dimuat ulang!', 'success');
            }
        } else {
            throw new Error(result.error || 'Failed to refresh FTP cache');
        }
        
    } catch (error) {
        console.error('Error refreshing FTP cache:', error);
        updateFTPStatus(false);
        showNotification('Error memuat ulang cache FTP: ' + error.message, 'error');
        showFTPError(error.message);
    } finally {
        hideLoading();
    }
}

function renderFTPTree(structure) {
    console.log('renderFTPTree called with structure:', structure);
    
    if (!structure) {
        console.log('No structure provided, showing empty state');
        showFTPEmpty();
        return;
    }
    
    hideFTPLoading();
    
    const tree = elements.ftpTree;
    tree.innerHTML = '';
    
    // Create tree structure
    const treeNode = createTreeNode(structure, structure.path || '/');
    tree.appendChild(treeNode);
    
    console.log('FTP tree rendered successfully');
}

function createTreeNode(item, fullPath) {
    const treeItem = document.createElement('div');
    treeItem.className = 'tree-item';
    
    const node = document.createElement('div');
    node.className = 'tree-node';
    
    // Create expand/collapse icon for directories
    let expandIcon = '';
    if (item.type === 'directory') {
        if (item.hasChildren) {
            expandIcon = item.loaded ? 
                '<span class="expand-icon" data-expanded="false">▶</span>' : 
                '<span class="expand-icon" data-expanded="false">▶</span>';
        } else {
            expandIcon = '<span class="expand-icon empty"></span>';
        }
    }
    
    // Add visual indicator for inaccessible folders
    const accessibilityClass = item.isAccessible === false ? ' inaccessible' : '';
    const accessibilityIcon = item.isAccessible === false ? ' 🔒' : '';
    
    node.innerHTML = `
        ${expandIcon}
        <span class="tree-icon">${item.type === 'directory' ? '📁' : '📄'}</span>
        <span class="tree-label${accessibilityClass}">${item.name || 'Root'}${accessibilityIcon}</span>
    `;
    
    // Add click handler for directories
    if (item.type === 'directory') {
        const expandIconEl = node.querySelector('.expand-icon');
        const labelEl = node.querySelector('.tree-label');
        
        // Handle expand/collapse
        if (expandIconEl && !expandIconEl.classList.contains('empty')) {
            expandIconEl.addEventListener('click', async (e) => {
                e.stopPropagation();
                await toggleDirectory(treeItem, item, fullPath, expandIconEl);
            });
        }
        
        // Handle directory selection
        labelEl.addEventListener('click', () => {
            selectFTPPath(fullPath, item);
            
            // Update active state
            document.querySelectorAll('.tree-node').forEach(n => n.classList.remove('active'));
            node.classList.add('active');
        });
    }
    
    treeItem.appendChild(node);
    
    // Add children container (initially hidden)
    if (item.type === 'directory' && item.hasChildren) {
        const childrenContainer = document.createElement('div');
        childrenContainer.className = 'tree-children';
        childrenContainer.style.display = 'none';
        
        // If already loaded, add children
        if (item.loaded && item.directories && item.directories.length > 0) {
            item.directories.forEach(child => {
                const childPath = fullPath === '/' ? `/${child.name}` : `${fullPath}/${child.name}`;
                const childNode = createTreeNode(child, childPath);
                childrenContainer.appendChild(childNode);
            });
        }
        
        treeItem.appendChild(childrenContainer);
    }
    
    return treeItem;
}

async function toggleDirectory(treeItem, item, fullPath, expandIconEl) {
    const childrenContainer = treeItem.querySelector('.tree-children');
    const isExpanded = expandIconEl.dataset.expanded === 'true';
    
    if (isExpanded) {
        // Collapse
        childrenContainer.style.display = 'none';
        expandIconEl.textContent = '▶';
        expandIconEl.dataset.expanded = 'false';
    } else {
        // Expand
        if (!item.loaded) {
            // Load directory contents lazily
            try {
                showLoading('Loading directory contents...');
                const result = await electronAPI.ftp.loadDirectory(fullPath);
                hideLoading();
                
                if (result.success) {
                    // Update item with loaded contents
                    item.directories = result.contents.directories || [];
                    item.files = result.contents.files || [];
                    item.loaded = true;
                    item.isAccessible = result.contents.isAccessible;
                    
                    // Clear and rebuild children
                    childrenContainer.innerHTML = '';
                    if (item.directories && item.directories.length > 0) {
                        item.directories.forEach(child => {
                            const childPath = fullPath === '/' ? `/${child.name}` : `${fullPath}/${child.name}`;
                            const childNode = createTreeNode(child, childPath);
                            childrenContainer.appendChild(childNode);
                        });
                    }
                } else {
                    // Check if this is an access denied error
                    if (result.error && (result.error.includes('Access denied') || result.error.includes('550'))) {
                        showNotification(`🔒 Directory "${item.name || fullPath}" is restricted and cannot be accessed. This directory may require special permissions.`, 'warning');
                    } else {
                        showNotification(`Failed to load directory: ${result.error}`, 'error');
                    }
                    return;
                }
            } catch (error) {
                hideLoading();
                
                // Check if this is an access denied error
                if (error.message && (error.message.includes('Access denied') || error.message.includes('550'))) {
                    showNotification(`🔒 Directory "${item.name || fullPath}" is restricted and cannot be accessed. This directory may require special permissions.`, 'warning');
                } else {
                    showNotification(`Error loading directory: ${error.message}`, 'error');
                }
                return;
            }
        }
        
        childrenContainer.style.display = 'block';
        expandIconEl.textContent = '▼';
        expandIconEl.dataset.expanded = 'true';
    }
}

async function selectFTPPath(path, item) {
    appState.selectedFtpPath = path;
    
    // Update breadcrumb
    elements.ftpBreadcrumb.textContent = path;
    
    // If directory hasn't been loaded yet, load it first
    if (item.type === 'directory' && !item.loaded) {
        try {
            showLoading('Loading directory contents...');
            const result = await electronAPI.ftp.loadDirectory(path);
            hideLoading();
            
            if (result.success) {
                // Update item with loaded contents
                item.files = result.contents.files || [];
                item.directories = result.contents.directories || [];
                item.loaded = true;
                item.isAccessible = result.contents.isAccessible;
            } else {
                hideLoading();
                if (result.error && (result.error.includes('Access denied') || result.error.includes('550'))) {
                    showNotification(`🔒 Directory "${item.name || path}" is restricted and cannot be accessed.`, 'warning');
                } else {
                    showNotification(`Failed to load directory: ${result.error}`, 'error');
                }
                return;
            }
        } catch (error) {
            hideLoading();
            if (error.message && (error.message.includes('Access denied') || error.message.includes('550'))) {
                showNotification(`🔒 Directory "${item.name || path}" is restricted and cannot be accessed.`, 'warning');
            } else {
                showNotification(`Error loading directory: ${error.message}`, 'error');
            }
            return;
        }
    }
    
    // Render files in the main area
    renderFTPFiles(item.files || [], path);
}

function renderFTPFiles(files, currentPath) {
    const fileList = elements.ftpFileList;
    
    if (!files || files.length === 0) {
        fileList.innerHTML = `
            <div class="empty-state">
                <p>Folder ini kosong</p>
            </div>
        `;
        return;
    }
    
    fileList.innerHTML = files.map(file => `
        <div class="file-item" data-file-name="${file.name}" data-file-path="${currentPath}/${file.name}">
            <div class="file-icon">${getFileIcon(file.name)}</div>
            <div class="file-details">
                <div class="file-name">${file.name}</div>
                <div class="file-meta">
                    ${formatFileSize(file.size)} • 
                    ${file.modifiedAt ? formatDate(file.modifiedAt) : 'Unknown date'}
                </div>
            </div>
        </div>
    `).join('');
    
    // Add double-click handlers to files
    fileList.querySelectorAll('.file-item').forEach(item => {
        item.addEventListener('dblclick', async () => {
            const fileName = item.dataset.fileName;
            const filePath = item.dataset.filePath;
            await downloadAndOpenFile(filePath, fileName);
        });
    });
}

async function downloadAndOpenFile(remotePath, fileName) {
    showLoading(`Mengunduh ${fileName}...`);
    
    try {
        const result = await electronAPI.ftp.downloadAndOpen(remotePath, fileName);
        
        if (result.success) {
            showNotification(`File ${fileName} berhasil dibuka!`, 'success');
        } else {
            throw new Error(result.error || 'Failed to download file');
        }
        
    } catch (error) {
        console.error('Error downloading file:', error);
        showNotification(`Error mengunduh file: ${error.message}`, 'error');
    } finally {
        hideLoading();
    }
}

// Chat functions
async function sendChatMessage() {
    const input = elements.messageInput;
    const message = input.value.trim();
    
    if (!message || !appState.chatConnected) {
        return;
    }
    
    try {
        const result = await electronAPI.chat.sendMessage(message);
        
        if (result.success) {
            input.value = '';
        } else {
            throw new Error(result.error || 'Failed to send message');
        }
        
    } catch (error) {
        console.error('Error sending message:', error);
        showNotification('Error mengirim pesan: ' + error.message, 'error');
    }
}

function handleChatMessage(message) {
    addMessageToChat(message);
}

function handleUserListUpdate(users) {
    appState.userList = users;
    renderUserList(users);
}

function handleChatError(error) {
    console.error('Chat error:', error);
    showNotification('Chat error: ' + error.message, 'error');
    
    if (error.type === 'connection_error') {
        appState.chatConnected = false;
        updateChatStatus(false);
        disableChatInput();
    }
}

function addMessageToChat(message) {
    const messagesContainer = elements.chatMessages;
    
    // Remove welcome message if it exists
    const welcomeMsg = messagesContainer.querySelector('.welcome-message');
    if (welcomeMsg) {
        welcomeMsg.remove();
    }
    
    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${message.type || 'user'}`;
    
    if (message.username === appState.currentChatUsername) {
        messageDiv.classList.add('own');
    }
    
    const avatarLetter = message.username ? message.username.charAt(0).toUpperCase() : 'S';
    
    messageDiv.innerHTML = `
        <div class="message-avatar">${avatarLetter}</div>
        <div class="message-content">
            <div class="message-header">
                <span class="message-author">${message.username}</span>
                <span class="message-time">${formatTime(message.timestamp)}</span>
            </div>
            <div class="message-text">${escapeHtml(message.message)}</div>
        </div>
    `;
    
    messagesContainer.appendChild(messageDiv);
    
    // Scroll to bottom
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

function renderUserList(users) {
    const userListContainer = elements.userList;
    const userCountElement = elements.userCount;
    
    userCountElement.textContent = users.length;
    
    if (users.length === 0) {
        userListContainer.innerHTML = `
            <div class="empty-state">
                <p>Belum ada pengguna online</p>
            </div>
        `;
        return;
    }
    
    userListContainer.innerHTML = users.map(user => `
        <div class="user-item online">
            <div class="user-avatar">${user.username.charAt(0).toUpperCase()}</div>
            <div class="user-info">
                <div class="user-name">${escapeHtml(user.username)}</div>
                <div class="user-status">Online</div>
            </div>
        </div>
    `).join('');
}

// UI utility functions
function switchTab(tabName) {
    appState.activeTab = tabName;
    
    // Update tab buttons
    elements.tabButtons.forEach(button => {
        if (button.dataset.tab === tabName) {
            button.classList.add('active');
        } else {
            button.classList.remove('active');
        }
    });
    
    // Update tab content
    if (tabName === 'ftp') {
        elements.ftpTab.classList.add('active');
        elements.chatTab.classList.remove('active');
    } else if (tabName === 'chat') {
        elements.ftpTab.classList.remove('active');
        elements.chatTab.classList.add('active');
    }
}

function showConfigModal() {
    elements.configModal.style.display = 'flex';
    elements.mainApp.style.display = 'none';
}

function hideConfigModal() {
    elements.configModal.style.display = 'none';
    elements.mainApp.style.display = 'flex';
}

function showLoading(text = 'Loading...') {
    elements.loadingText.textContent = text;
    elements.loadingOverlay.style.display = 'flex';
}

function hideLoading() {
    elements.loadingOverlay.style.display = 'none';
}

function showNotification(text, type = 'info') {
    elements.notificationText.textContent = text;
    elements.notification.className = `notification ${type}`;
    elements.notification.style.display = 'flex';
    
    // Auto hide after 5 seconds
    setTimeout(() => {
        hideNotification();
    }, 5000);
}

function hideNotification() {
    elements.notification.style.display = 'none';
}

function updateFTPStatus(connected) {
    appState.ftpConnected = connected;
    elements.ftpStatus.textContent = connected ? 'FTP: Connected' : 'FTP: Disconnected';
    elements.ftpStatus.className = `status-indicator ${connected ? 'connected' : ''}`;
}

function updateChatStatus(connected) {
    const statusDot = elements.chatConnectionStatus.querySelector('.status-dot');
    const statusText = elements.chatConnectionStatus.querySelector('span:last-child');
    
    if (connected) {
        statusDot.className = 'status-dot online';
        statusText.textContent = 'Online';
        elements.chatStatus.textContent = 'Chat: Connected';
        elements.chatStatus.className = 'status-indicator connected';
    } else {
        statusDot.className = 'status-dot offline';
        statusText.textContent = 'Offline';
        elements.chatStatus.textContent = 'Chat: Disconnected';
        elements.chatStatus.className = 'status-indicator';
    }
}

function enableChatInput() {
    elements.messageInput.disabled = false;
    elements.sendButton.disabled = false;
    elements.messageInput.placeholder = 'Ketik pesan Anda...';
}

function disableChatInput() {
    elements.messageInput.disabled = true;
    elements.sendButton.disabled = true;
    elements.messageInput.placeholder = 'Tidak terhubung ke chat server';
}

function showFTPError(message) {
    elements.ftpTree.innerHTML = `
        <div class="empty-state">
            <p>❌ Error: ${message}</p>
            <button onclick="refreshFTPCache()" style="margin-top: 16px; padding: 8px 16px; background: #007AFF; color: white; border: none; border-radius: 6px; cursor: pointer;">
                Coba Lagi
            </button>
        </div>
    `;
}

function showChatError(message) {
    elements.chatMessages.innerHTML = `
        <div class="empty-state">
            <p>❌ Error: ${message}</p>
            <button onclick="initializeChat()" style="margin-top: 16px; padding: 8px 16px; background: #007AFF; color: white; border: none; border-radius: 6px; cursor: pointer;">
                Coba Lagi
            </button>
        </div>
    `;
}

function hideFTPLoading() {
    elements.ftpLoading.style.display = 'none';
}

function showFTPEmpty() {
    hideFTPLoading();
    elements.ftpEmpty.style.display = 'block';
}

function clearFormErrors() {
    document.querySelectorAll('.error-text').forEach(el => el.textContent = '');
}

function showFieldError(fieldId, message) {
    const errorElement = document.getElementById(fieldId);
    if (errorElement) {
        errorElement.textContent = message;
    }
}

async function refreshAll() {
    showLoading('Memuat ulang semua data...');
    
    try {
        await refreshFTPCache();
        // Could add chat reconnection here if needed
        showNotification('Semua data berhasil dimuat ulang!', 'success');
    } catch (error) {
        console.error('Error refreshing all:', error);
        showNotification('Error memuat ulang data: ' + error.message, 'error');
    } finally {
        hideLoading();
    }
}

// Utility functions
function getFileIcon(filename) {
    const ext = filename.split('.').pop().toLowerCase();
    const iconMap = {
        // Images
        'jpg': '🖼️', 'jpeg': '🖼️', 'png': '🖼️', 'gif': '🖼️', 'bmp': '🖼️', 'svg': '🖼️',
        // Documents
        'pdf': '📄', 'doc': '📄', 'docx': '📄', 'txt': '📄', 'rtf': '📄',
        // Spreadsheets
        'xls': '📊', 'xlsx': '📊', 'csv': '📊',
        // Presentations
        'ppt': '📊', 'pptx': '📊',
        // Archives
        'zip': '🗜️', 'rar': '🗜️', '7z': '🗜️', 'tar': '🗜️', 'gz': '🗜️',
        // Code
        'js': '💻', 'html': '💻', 'css': '💻', 'php': '💻', 'py': '💻', 'java': '💻',
        // Audio
        'mp3': '🎵', 'wav': '🎵', 'flac': '🎵', 'aac': '🎵',
        // Video
        'mp4': '🎥', 'avi': '🎥', 'mkv': '🎥', 'mov': '🎥', 'wmv': '🎥'
    };
    return iconMap[ext] || '📄';
}

function formatFileSize(bytes) {
    if (!bytes) return '0 B';
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return Math.round(bytes / Math.pow(1024, i) * 100) / 100 + ' ' + sizes[i];
}

function formatDate(dateString) {
    const date = new Date(dateString);
    return date.toLocaleDateString('id-ID');
}

function formatTime(dateString) {
    const date = new Date(dateString);
    return date.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Make some functions globally available
window.refreshFTPCache = refreshFTPCache;
window.initializeChat = initializeChat;
