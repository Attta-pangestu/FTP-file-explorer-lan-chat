// Global application state
let appState = {
    config: null,
    ftpConnected: false,
    activeTab: 'ftp',
    ftpStructure: null,
    selectedFtpPath: null
};

// DOM element references
const elements = {
    // Modal elements
    configModal: document.getElementById('configModal'),
    configForm: document.getElementById('configForm'),
    mainApp: document.getElementById('mainApp'),
    
    // Status elements
    ftpStatus: document.getElementById('ftpStatus'),
    
    // Tab elements
    tabButtons: document.querySelectorAll('.tab-button'),
    ftpTab: document.getElementById('ftpTab'),
    
    // FTP elements
    ftpTree: document.getElementById('ftpTree'),
    ftpFileList: document.getElementById('ftpFileList'),
    ftpBreadcrumb: document.getElementById('ftpBreadcrumb'),
    ftpLoading: document.getElementById('ftpLoading'),
    ftpEmpty: document.getElementById('ftpEmpty'),
    

    
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
        
        // Always show configuration modal as startup screen
        console.log('Showing FTP configuration as startup screen');
        showConfigModal();
        
        // Auto-load existing configuration
        await loadConfiguration();
        
        // Check if configuration exists and populate form
        console.log('=== CONFIGURATION AUTO-LOAD ===');
        console.log('Loaded configuration:', JSON.stringify(appState.config, null, 2));
        const hasValidConfig = appState.config && 
                              appState.config.ftp && appState.config.ftp.host;
        
        console.log('Has valid config:', hasValidConfig);
        
        if (hasValidConfig) {
            // Auto-populate configuration form
            console.log('Auto-populating configuration form with existing data');
            populateConfigForm(appState.config);
            
            // Auto-connect if configuration is valid
            console.log('Valid configuration found, auto-connecting to FTP...');
            hideConfigModal();
            await initializeConnections();
        } else {
            console.log('No existing configuration found, showing empty form');
        }
        
        console.log('Application initialized successfully - Configuration screen ready');
        
    } catch (error) {
        console.error('Error initializing application:', error);
        showNotification('Error initializing application: ' + error.message, 'error');
    }
});

// Lazy loading version of toggleDirectory for Windows Explorer-like behavior
async function toggleDirectoryLazy(treeItem, item, fullPath, expandIconEl) {
    const childrenContainer = treeItem.querySelector('.tree-children');
    const isExpanded = expandIconEl.dataset.expanded === 'true';
    
    if (isExpanded) {
        // Collapse
        childrenContainer.style.display = 'none';
        expandIconEl.textContent = '▶';
        expandIconEl.dataset.expanded = 'false';
        
        // Remove from visible directories
        await electronAPI.ftp.setVisibleDirectories([]);
    } else {
        // Expand - load directory contents lazily
        try {
            // Show skeleton immediately for better UX
            showDirectoryExpandSkeleton(childrenContainer);
            expandIconEl.textContent = '▼';
            expandIconEl.dataset.expanded = 'true';
            
            // Use lazy loading to get directory contents
            const result = await electronAPI.ftp.loadDirectoryLazy(fullPath, { priority: 'high' });
            
            if (result.success && result.structure) {
                // Clear and rebuild children
                childrenContainer.innerHTML = '';
                
                if (result.structure.directories && result.structure.directories.length > 0) {
                    result.structure.directories.forEach(child => {
                        const childPath = fullPath === '/' ? `/${child.name}` : `${fullPath}/${child.name}`;
                        const childNode = createTreeNodeLazy(child, childPath);
                        childrenContainer.appendChild(childNode);
                    });
                }
                
                // Set as visible directory for background monitoring
                await electronAPI.ftp.setVisibleDirectories([fullPath]);
                await electronAPI.ftp.addMonitoredDirectory(fullPath);
                
                childrenContainer.style.display = 'block';
                expandIconEl.textContent = '▼';
                expandIconEl.dataset.expanded = 'true';
            } else {
                // Handle errors gracefully
                if (result.error && (result.error.includes('Access denied') || result.error.includes('550'))) {
                    showNotification(`🔒 Access Restricted: Directory "${item.name || fullPath}" requires special permissions.`, 'warning');
                } else {
                    showNotification(`⚠️ Directory Load Failed: ${result.error || 'Unknown error'}`, 'error');
                }
                return;
            }
        } catch (error) {
            hideLoading();
            
            if (error.message && (error.message.includes('Access denied') || error.message.includes('550'))) {
                showNotification(`🔒 Access Restricted: Directory "${item.name || fullPath}" requires special permissions.`, 'warning');
            } else {
                showNotification(`⚠️ Directory Error: ${error.message}`, 'error');
            }
            return;
        }
    }
}

// Lazy loading version of selectFTPPath for Windows Explorer-like behavior
async function selectFTPPathLazy(path, item) {
    appState.selectedFtpPath = path;
    
    // Update breadcrumb
    elements.ftpBreadcrumb.textContent = path;
    
    // Update tree selection visual
    updateTreeSelection(path);
    
    // If directory, load its contents lazily for the file list
    if (item.type === 'directory') {
        try {
            // Show skeleton screen immediately for better UX
            showFileListSkeleton();
            
            // Use lazy loading to get directory contents
            const result = await electronAPI.ftp.loadDirectoryLazy(path, { priority: 'high' });
            
            if (result.success && result.structure) {
                // Render the file list with loaded contents
                renderFTPContent(
                    result.structure.directories || [],
                    result.structure.files || [],
                    path
                );
                
                // Set as visible directory and add to monitoring
                await electronAPI.ftp.setVisibleDirectories([path]);
                await electronAPI.ftp.addMonitoredDirectory(path);
                await electronAPI.ftp.updateWorkerActivity();
            } else {
                // Handle errors
                if (result.error && (result.error.includes('Access denied') || result.error.includes('550'))) {
                    showNotification(`🔒 Access Restricted: Directory "${path}" requires special permissions.`, 'warning');
                    showFTPEmpty();
                } else {
                    showNotification(`⚠️ Directory Load Failed: ${result.error || 'Unknown error'}`, 'error');
                    showFTPEmpty();
                }
            }
        } catch (error) {
            hideLoading();
            
            if (error.message && (error.message.includes('Access denied') || error.message.includes('550'))) {
                showNotification(`🔒 Access Restricted: Directory "${path}" requires special permissions.`, 'warning');
            } else {
                showNotification(`⚠️ Directory Error: ${error.message}`, 'error');
            }
            showFTPEmpty();
        }
    }
}

// Setup all event listeners
function setupEventListeners() {
    console.log('Setting up event listeners...');
    
    // Configuration form events
    elements.configForm.addEventListener('submit', handleConfigSubmit);
    document.getElementById('cancelConfig').addEventListener('click', hideConfigModal);
    document.getElementById('testFtpButton').addEventListener('click', testFTPConnection);
    document.getElementById('connectFtpButton').addEventListener('click', handleConnectFTP);
    
    // Import/Export config buttons
    const importButton = document.getElementById('importConfigButton');
    const exportButton = document.getElementById('exportConfigButton');
    const fileInput = document.getElementById('configFileInput');
    
    console.log('Import button:', importButton);
    console.log('Export button:', exportButton);
    console.log('File input:', fileInput);
    
    if (importButton) {
        importButton.addEventListener('click', handleImportConfig);
        console.log('Import button event listener added');
    } else {
        console.error('Import button not found!');
    }
    
    if (exportButton) {
        exportButton.addEventListener('click', handleExportConfig);
        console.log('Export button event listener added');
    } else {
        console.error('Export button not found!');
    }
    
    if (fileInput) {
        fileInput.addEventListener('change', handleConfigFileSelect);
        console.log('File input event listener added');
    } else {
        console.error('File input not found!');
    }

    
    // Header button events
    document.getElementById('settingsButton').addEventListener('click', showConfigModal);
    document.getElementById('refreshButton').addEventListener('click', refreshAll);
    document.getElementById('refreshFtpButton').addEventListener('click', refreshFTPCache);
    
    // Tab navigation events
    elements.tabButtons.forEach(button => {
        button.addEventListener('click', () => switchTab(button.dataset.tab));
    });
    

    
    // Notification close event
    elements.notificationClose.addEventListener('click', hideNotification);
    

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

// Import configuration functionality
function handleImportConfig() {
    console.log('handleImportConfig called');
    const fileInput = document.getElementById('configFileInput');
    console.log('fileInput element:', fileInput);
    if (fileInput) {
        fileInput.click();
    } else {
        console.error('configFileInput element not found');
        showNotification('❌ Error: File input not found', 'error');
    }
}

async function handleConfigFileSelect(event) {
    const file = event.target.files[0];
    if (!file) return;
    
    try {
        const text = await file.text();
        const config = JSON.parse(text);
        
        // Validate config structure
        if (!config.ftp || !config.ftp.host) {
            throw new Error('Invalid config file format');
        }
        
        // Populate form with imported config
        document.getElementById('ftpHost').value = config.ftp.host || '';
        document.getElementById('ftpPort').value = config.ftp.port || 21;
        document.getElementById('ftpUsername').value = config.ftp.username || '';
        document.getElementById('ftpPassword').value = config.ftp.password || '';
        document.getElementById('ftpSecure').checked = config.ftp.secure || false;
        
        showNotification('✅ Config berhasil diimport!', 'success');
        
    } catch (error) {
        showNotification('❌ Error importing config: ' + error.message, 'error');
    }
    
    // Reset file input
    event.target.value = '';
}

function handleExportConfig() {
    try {
        // Get current form values
        const config = {
            ftp: {
                host: document.getElementById('ftpHost').value,
                port: parseInt(document.getElementById('ftpPort').value) || 21,
                username: document.getElementById('ftpUsername').value,
                password: document.getElementById('ftpPassword').value,
                secure: document.getElementById('ftpSecure').checked
            },
            exportDate: new Date().toISOString(),
            version: '1.0'
        };
        
        // Create and download file
        const configJson = JSON.stringify(config, null, 2);
        const blob = new Blob([configJson], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        
        const a = document.createElement('a');
        a.href = url;
        a.download = `ftp-config-${new Date().toISOString().split('T')[0]}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        
        showNotification('✅ Config berhasil diexport!', 'success');
        
    } catch (error) {
        showNotification('❌ Error exporting config: ' + error.message, 'error');
    }
}

// Connection management
async function initializeConnections() {
    showLoading('Menginisialisasi koneksi dan sistem caching...');
    
    try {
        console.log('=== INITIALIZING INTELLIGENT CACHING SYSTEM ===');
        
        // Check if cache data is available
        const cacheExists = await electronAPI.ftp.checkCacheExists();
        console.log('Cache exists:', cacheExists);
        
        if (cacheExists) {
            console.log('Using existing cache data for faster loading...');
            showLoading('Memuat data dari cache...');
            
            // Load from cache first for instant UI
            await initializeFTP();
            
            // Then refresh in background
            console.log('Starting background cache refresh...');
            setTimeout(async () => {
                try {
                    await refreshFTPCache(true);
                    console.log('Background cache refresh completed');
                } catch (error) {
                    console.error('Background refresh error:', error);
                }
            }, 2000);
            
        } else {
            console.log('No cache available, fetching fresh data from server...');
            showLoading('Mengambil data dari server FTP...');
            
            // Initialize FTP and fetch fresh data
            await initializeFTP();
        }
        
        // Start background worker for continuous updates
        console.log('Starting background worker for continuous monitoring...');
        await electronAPI.ftp.startBackgroundWorker();
        
        showNotification('Sistem caching dan koneksi FTP siap!', 'success');
        
    } catch (error) {
        console.error('Error initializing connections:', error);
        showNotification('Error menginisialisasi koneksi: ' + error.message, 'error');
    } finally {
        hideLoading();
    }
}

async function initializeFTP() {
    try {
        console.log('Initializing FTP with lazy loading...');
        
        // Show skeleton screen immediately for better UX
        showTreeSkeleton();
        
        // Initialize username for cache system
        await electronAPI.ftp.initUsername();
        
        // Start background worker for continuous monitoring
        await electronAPI.ftp.startBackgroundWorker(30000); // 30 seconds interval
        
        // Load root directory using lazy loading
        const rootStructure = await electronAPI.ftp.loadDirectoryLazy('/', { priority: 'high' });
        
        console.log('Root directory loaded:', rootStructure);
        
        appState.ftpStructure = rootStructure;
        renderFTPTreeLazy(rootStructure);
        updateFTPStatus(true);
        
        // Set root as visible directory
        await electronAPI.ftp.setVisibleDirectories(['/']);
        
        console.log('FTP initialized with lazy loading successfully');
        
    } catch (error) {
        console.error('Error initializing FTP:', error);
        updateFTPStatus(false);
        showFTPError('Gagal memuat data FTP: ' + error.message);
    }
}




// FTP functions
async function refreshFTPCache(forceRefresh = true) {
    showLoading('Memuat ulang cache FTP...');
    
    try {
        console.log('Refreshing FTP cache with lazy loading...');
        
        // Clear lazy cache if force refresh
        if (forceRefresh) {
            await electronAPI.ftp.clearLazyCache();
        }
        
        // Refresh visible directories
        await electronAPI.ftp.refreshVisibleDirectories();
        
        // Load root directory with lazy loading
        const result = await electronAPI.ftp.loadDirectoryLazy('/', { priority: 'high', forceRefresh });
        
        if (result.success && result.structure) {
            console.log('FTP data refreshed with lazy loading');
            appState.ftpStructure = result;
            renderFTPTreeLazy(result);
            updateFTPStatus(true);
            
            // Set root as visible and start monitoring
            await electronAPI.ftp.setVisibleDirectories(['/']);
            await electronAPI.ftp.addMonitoredDirectory('/');
            
            showNotification('Cache FTP berhasil dimuat ulang!', 'success');
        } else {
            throw new Error(result.error || 'Failed to refresh FTP cache with lazy loading');
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

// New lazy loading tree renderer for Windows Explorer-like behavior
function renderFTPTreeLazy(directoryData, parentPath = '') {
    console.log('renderFTPTreeLazy called with:', directoryData, 'parentPath:', parentPath);
    console.log('Directory structure:', JSON.stringify(directoryData.structure, null, 2));
    
    if (!directoryData || !directoryData.structure) {
        console.log('No directory data provided, showing empty state');
        if (parentPath === '') {
            showFTPEmpty();
        }
        return;
    }
    
    hideFTPLoading();
    
    const tree = elements.ftpTree;
    console.log('FTP Tree element:', tree);
    
    if (parentPath === '') {
        // Root directory - clear and render
        console.log('Rendering root directory...');
        tree.innerHTML = '';
        
        // Check if we have directories to render
        if (directoryData.structure.directories && directoryData.structure.directories.length > 0) {
            console.log('Found', directoryData.structure.directories.length, 'directories to render');
            directoryData.structure.directories.forEach((child, index) => {
                console.log(`Creating node ${index + 1}:`, child.name);
                const childPath = `/${child.name}`;
                const childNode = createTreeNodeLazy(child, childPath);
                tree.appendChild(childNode);
            });
        } else {
            console.log('No directories found in structure');
        }
    } else {
        // Update specific directory content
        const targetElement = tree.querySelector(`[data-path="${parentPath}"]`);
        if (targetElement) {
            const childrenContainer = targetElement.querySelector('.tree-children');
            if (childrenContainer && directoryData.structure.directories) {
                childrenContainer.innerHTML = '';
                directoryData.structure.directories.forEach(child => {
                    const childPath = parentPath === '/' ? `/${child.name}` : `${parentPath}/${child.name}`;
                    const childNode = createTreeNodeLazy(child, childPath);
                    childrenContainer.appendChild(childNode);
                });
            }
        }
    }
    
    console.log('FTP tree rendered successfully with lazy loading');
    console.log('Tree HTML after rendering:', tree.innerHTML.substring(0, 500));
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

// Lazy loading version of createTreeNode for Windows Explorer-like behavior
function createTreeNodeLazy(item, fullPath) {
    const treeItem = document.createElement('div');
    treeItem.className = 'tree-item';
    treeItem.setAttribute('data-path', fullPath);
    
    const node = document.createElement('div');
    node.className = 'tree-node';
    
    // Create expand/collapse icon for directories
    let expandIcon = '';
    if (item.type === 'directory') {
        expandIcon = '<span class="expand-icon" data-expanded="false">▶</span>';
    }
    
    // Add visual indicator for inaccessible folders
    const accessibilityClass = item.isAccessible === false ? ' inaccessible' : '';
    const accessibilityIcon = item.isAccessible === false ? ' 🔒' : '';
    
    node.innerHTML = `
        ${expandIcon}
        <span class="tree-icon">${item.type === 'directory' ? '📁' : '📄'}</span>
        <span class="tree-label${accessibilityClass}">${item.name || 'Root'}${accessibilityIcon}</span>
    `;
    
    // Add click handler for directories with lazy loading
    if (item.type === 'directory') {
        const expandIconEl = node.querySelector('.expand-icon');
        const labelEl = node.querySelector('.tree-label');
        
        // Handle expand/collapse with lazy loading
        if (expandIconEl) {
            expandIconEl.addEventListener('click', async (e) => {
                e.stopPropagation();
                await toggleDirectoryLazy(treeItem, item, fullPath, expandIconEl);
            });
        }
        
        // Handle directory selection
        if (labelEl) {
            labelEl.addEventListener('click', async (e) => {
                e.stopPropagation();
                await selectFTPPathLazy(fullPath, item);
            });
        }
    }
    
    treeItem.appendChild(node);
    
    // Add children container for directories
    if (item.type === 'directory') {
        const childrenContainer = document.createElement('div');
        childrenContainer.className = 'tree-children';
        childrenContainer.style.display = 'none';
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
                        showNotification(`🔒 Access Restricted: Directory "${item.name || fullPath}" requires special permissions. You can continue browsing other accessible directories.`, 'warning');
                    } else {
                        showNotification(`⚠️ Directory Load Failed: ${result.error}. Other directories remain accessible.`, 'error');
                    }
                    return;
                }
            } catch (error) {
                hideLoading();
                
                // Check if this is an access denied error
                if (error.message && (error.message.includes('Access denied') || error.message.includes('550'))) {
                    showNotification(`🔒 Access Restricted: Directory "${item.name || fullPath}" requires special permissions. You can continue browsing other accessible directories.`, 'warning');
                } else {
                    showNotification(`⚠️ Directory Error: ${error.message}. Other directories remain accessible.`, 'error');
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
                    showNotification(`🔒 Access Restricted: Directory "${item.name || path}" requires special permissions. You can continue browsing other accessible directories.`, 'warning');
                } else {
                    showNotification(`⚠️ Directory Load Failed: ${result.error}. Other directories remain accessible.`, 'error');
                }
                return;
            }
        } catch (error) {
            hideLoading();
            if (error.message && (error.message.includes('Access denied') || error.message.includes('550'))) {
                showNotification(`🔒 Access Restricted: Directory "${item.name || path}" requires special permissions. You can continue browsing other accessible directories.`, 'warning');
            } else {
                showNotification(`⚠️ Directory Error: ${error.message}. Other directories remain accessible.`, 'error');
            }
            return;
        }
    }
    
    // Render both directories and files in the main area
    renderFTPContent(item.directories || [], item.files || [], path);
}

function renderFTPContent(directories, files, currentPath) {
    const fileList = elements.ftpFileList;
    
    if ((!directories || directories.length === 0) && (!files || files.length === 0)) {
        fileList.innerHTML = `
            <div class="empty-state">
                <p>Folder ini kosong</p>
            </div>
        `;
        // Hide delete controls when no content
        toggleDeleteControls(false);
        return;
    }
    
    const directoryItems = (directories || []).map(dir => `
        <div class="file-item selectable" data-name="${dir.name}" data-path="${currentPath === '/' ? '/' + dir.name : currentPath + '/' + dir.name}" data-type="directory">
            <input type="checkbox" class="file-item-checkbox" onchange="toggleItemSelection(this.parentElement, this)">
            <div class="file-icon">📁</div>
            <div class="file-details">
                <div class="file-name">${dir.name}</div>
                <div class="file-meta">
                    Directory • 
                    ${dir.modifiedAt ? formatDate(dir.modifiedAt) : 'Unknown date'}
                </div>
            </div>
        </div>
    `);
    
    const fileItems = (files || []).map(file => {
        const filePath = currentPath === '/' ? '/' + file.name : currentPath + '/' + file.name;
        return `
        <div class="file-item selectable" data-name="${file.name}" data-path="${filePath}" data-type="file" data-file-name="${file.name}" data-file-path="${filePath}">
            <input type="checkbox" class="file-item-checkbox" onchange="toggleItemSelection(this.parentElement, this)">
            <div class="file-icon">${getFileIcon(file.name)}</div>
            <div class="file-details">
                <div class="file-name">${file.name}</div>
                <div class="file-meta">
                    ${formatFileSize(file.size)} • 
                    ${file.modifiedAt ? formatDate(file.modifiedAt) : 'Unknown date'}
                </div>
            </div>
            <div class="file-actions">
                <button class="edit-btn" onclick="openFileEditor('${filePath}', '${file.name}')" title="Edit file">
                    ✏️
                </button>
                <button class="replace-btn" onclick="openFileReplace('${filePath}', '${file.name}')" title="Replace file">
                    🔄
                </button>
            </div>
        </div>
    `;
    });
    
    fileList.innerHTML = [...directoryItems, ...fileItems].join('');
    
    // Show delete controls when content is present
    toggleDeleteControls(true);
    
    // Add double-click handlers
    fileList.querySelectorAll('.file-item').forEach(item => {
        const itemType = item.dataset.type;
        
        item.addEventListener('dblclick', async () => {
            if (itemType === 'directory') {
                // Navigate to directory
                const dirPath = item.dataset.path;
                await navigateToDirectory(dirPath);
            } else {
                // Download and open file
                const fileName = item.dataset.fileName;
                const filePath = item.dataset.filePath;
                await downloadAndOpenFile(filePath, fileName);
            }
        });
    });
    
    // Update delete info
    updateDeleteInfo();
}

// Keep the old function for backward compatibility
function renderFTPFiles(files, currentPath) {
    renderFTPContent([], files, currentPath);
}

// File Editor Functionality
let currentEditingFile = null;

function initializeFileEditor() {
    const fileEditorModal = document.getElementById('fileEditorModal');
    const fileReplaceModal = document.getElementById('fileReplaceModal');
    const closeEditorBtn = document.getElementById('closeEditorBtn');
    const cancelEditBtn = document.getElementById('cancelEditBtn');
    const saveFileBtn = document.getElementById('saveFileBtn');
    const closeReplaceBtn = document.getElementById('closeReplaceBtn');
    const cancelReplaceBtn = document.getElementById('cancelReplaceBtn');
    const browseReplaceBtn = document.getElementById('browseReplaceBtn');
    const replaceFileInput = document.getElementById('replaceFileInput');
    const confirmReplaceBtn = document.getElementById('confirmReplaceBtn');

    // Editor modal event listeners
    closeEditorBtn.addEventListener('click', closeFileEditor);
    cancelEditBtn.addEventListener('click', closeFileEditor);
    saveFileBtn.addEventListener('click', saveFileContent);

    // Replace modal event listeners
    closeReplaceBtn.addEventListener('click', closeFileReplace);
    cancelReplaceBtn.addEventListener('click', closeFileReplace);
    browseReplaceBtn.addEventListener('click', () => replaceFileInput.click());
    confirmReplaceBtn.addEventListener('click', confirmFileReplace);
    
    replaceFileInput.addEventListener('change', handleReplaceFileSelection);

    // Close modals when clicking outside
    fileEditorModal.addEventListener('click', (e) => {
        if (e.target === fileEditorModal) closeFileEditor();
    });
    
    fileReplaceModal.addEventListener('click', (e) => {
        if (e.target === fileReplaceModal) closeFileReplace();
    });
}

async function openFileEditor(remotePath, fileName) {
    try {
        showEditorStatus('Loading file content...', 'loading');
        
        const fileEditorModal = document.getElementById('fileEditorModal');
        const editorTitle = document.getElementById('editorTitle');
        const editorFilePath = document.getElementById('editorFilePath');
        const fileContentEditor = document.getElementById('fileContentEditor');
        
        editorTitle.textContent = `Edit: ${fileName}`;
        editorFilePath.textContent = remotePath;
        fileContentEditor.value = 'Loading...';
        
        fileEditorModal.style.display = 'flex';
        currentEditingFile = { remotePath, fileName };
        
        // Get file content from FTP server
        const result = await electronAPI.ftp.getFileContent(remotePath);
        
        if (result.success) {
            fileContentEditor.value = result.content;
            document.getElementById('editorFileSize').textContent = `Size: ${formatFileSize(result.size)}`;
            showEditorStatus('File loaded successfully', 'success');
            setTimeout(() => hideEditorStatus(), 3000);
        } else {
            throw new Error(result.message || 'Failed to load file content');
        }
        
    } catch (error) {
        console.error('Error opening file editor:', error);
        showEditorStatus(`Error: ${error.message}`, 'error');
        showNotification(`Failed to open file: ${error.message}`, 'error');
    }
}

async function saveFileContent() {
    if (!currentEditingFile) return;
    
    try {
        const fileContentEditor = document.getElementById('fileContentEditor');
        const content = fileContentEditor.value;
        
        showEditorStatus('Saving file...', 'loading');
        
        const result = await electronAPI.ftp.updateFile(
            currentEditingFile.remotePath,
            content
        );
        
        if (result.success) {
            showEditorStatus('File saved successfully!', 'success');
            showNotification('File updated successfully', 'success');
            
            // Refresh the current directory to show updated file
            if (appState.selectedFtpPath) {
                await selectFTPPath(appState.selectedFtpPath, null);
            }
            
            setTimeout(() => {
                closeFileEditor();
            }, 2000);
        } else {
            throw new Error(result.message || 'Failed to save file');
        }
        
    } catch (error) {
        console.error('Error saving file:', error);
        showEditorStatus(`Error: ${error.message}`, 'error');
        showNotification(`Failed to save file: ${error.message}`, 'error');
    }
}

function closeFileEditor() {
    const fileEditorModal = document.getElementById('fileEditorModal');
    fileEditorModal.style.display = 'none';
    currentEditingFile = null;
    hideEditorStatus();
}

function showEditorStatus(message, type) {
    const editorStatus = document.getElementById('editorStatus');
    const editorStatusText = document.getElementById('editorStatusText');
    
    editorStatus.className = `editor-status ${type}`;
    editorStatusText.textContent = message;
    editorStatus.style.display = 'block';
}

function hideEditorStatus() {
    const editorStatus = document.getElementById('editorStatus');
    editorStatus.style.display = 'none';
}

// File Replace Functionality
let currentReplaceFile = null;
let selectedReplaceFile = null;

function openFileReplace(remotePath, fileName) {
    const fileReplaceModal = document.getElementById('fileReplaceModal');
    const replaceFilePath = document.getElementById('replaceFilePath');
    const replaceFileInfo = document.getElementById('replaceFileInfo');
    const confirmReplaceBtn = document.getElementById('confirmReplaceBtn');
    
    replaceFilePath.textContent = remotePath;
    replaceFileInfo.style.display = 'none';
    confirmReplaceBtn.disabled = true;
    
    fileReplaceModal.style.display = 'flex';
    currentReplaceFile = { remotePath, fileName };
    selectedReplaceFile = null;
}

function handleReplaceFileSelection(event) {
    const file = event.target.files[0];
    if (!file) return;
    
    selectedReplaceFile = file;
    
    const replaceFileInfo = document.getElementById('replaceFileInfo');
    const replaceFileName = document.getElementById('replaceFileName');
    const replaceFileSize = document.getElementById('replaceFileSize');
    const confirmReplaceBtn = document.getElementById('confirmReplaceBtn');
    
    replaceFileName.textContent = file.name;
    replaceFileSize.textContent = formatFileSize(file.size);
    replaceFileInfo.style.display = 'block';
    confirmReplaceBtn.disabled = false;
}

async function confirmFileReplace() {
    if (!currentReplaceFile || !selectedReplaceFile) return;
    
    try {
        const replaceProgress = document.getElementById('replaceProgress');
        const replaceProgressFill = document.getElementById('replaceProgressFill');
        const replaceProgressText = document.getElementById('replaceProgressText');
        
        replaceProgress.style.display = 'block';
        
        const result = await electronAPI.ftp.replaceFile(
            currentReplaceFile.remotePath,
            selectedReplaceFile
        );
        
        if (result.success) {
            showNotification('File replaced successfully', 'success');
            
            // Refresh the current directory
            if (appState.selectedFtpPath) {
                await selectFTPPath(appState.selectedFtpPath, null);
            }
            
            closeFileReplace();
        } else {
            throw new Error(result.message || 'Failed to replace file');
        }
        
    } catch (error) {
        console.error('Error replacing file:', error);
        showNotification(`Failed to replace file: ${error.message}`, 'error');
    }
}

function closeFileReplace() {
    const fileReplaceModal = document.getElementById('fileReplaceModal');
    const replaceProgress = document.getElementById('replaceProgress');
    const replaceFileInput = document.getElementById('replaceFileInput');
    
    fileReplaceModal.style.display = 'none';
    replaceProgress.style.display = 'none';
    replaceFileInput.value = '';
    
    currentReplaceFile = null;
    selectedReplaceFile = null;
}

async function navigateToDirectory(dirPath) {
    try {
        showLoading('Loading directory...');
        const result = await electronAPI.ftp.loadDirectory(dirPath);
        hideLoading();
        
        if (result.success) {
            // Update current path
            currentPath = dirPath;
            
            // Update breadcrumb
            elements.ftpBreadcrumb.textContent = dirPath;
            
            // Render the directory contents
            renderFTPContent(result.contents.directories || [], result.contents.files || [], dirPath);
            
            // Update tree selection if needed
            updateTreeSelection(dirPath);
        } else {
            if (result.error && (result.error.includes('Access denied') || result.error.includes('550'))) {
                showNotification(`🔒 Access Restricted: Directory "${dirPath}" requires special permissions.`, 'warning');
            } else {
                showNotification(`⚠️ Directory Load Failed: ${result.error}`, 'error');
            }
        }
    } catch (error) {
        hideLoading();
        if (error.message && (error.message.includes('Access denied') || error.message.includes('550'))) {
            showNotification(`🔒 Access Restricted: Directory "${dirPath}" requires special permissions.`, 'warning');
        } else {
            showNotification(`⚠️ Directory Error: ${error.message}`, 'error');
        }
    }
}

function updateTreeSelection(path) {
    // Remove previous selection
    document.querySelectorAll('.tree-item.selected').forEach(item => {
        item.classList.remove('selected');
    });
    
    // Find and select the current path in tree
    const treeItems = document.querySelectorAll('.tree-item');
    treeItems.forEach(item => {
        if (item.dataset.path === path) {
            item.classList.add('selected');
        }
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

// Enhanced download function with progress tracking and resume capability
let downloadProgressCleanup = null;

async function downloadFileWithProgress(remotePath, fileName, localPath = null) {
    try {
        // If no local path provided, use downloads directory
        if (!localPath) {
            const downloadsPath = await electronAPI.dialog.showSaveDialog({
                defaultPath: fileName,
                filters: [
                    { name: 'All Files', extensions: ['*'] }
                ]
            });
            
            if (downloadsPath.canceled) {
                return;
            }
            
            localPath = downloadsPath.filePath;
        }
        
        showDownloadProgress(fileName);
        
        // Set up progress listener
        downloadProgressCleanup = electronAPI.ftp.onDownloadProgress((data) => {
            updateDownloadProgress(data);
        });
        
        const result = await electronAPI.ftp.downloadWithProgress(remotePath, localPath, true);
        
        if (result.success) {
            const resumeText = result.resumed ? ' (resumed)' : '';
            showNotification(`File ${fileName} berhasil diunduh${resumeText}!`, 'success');
            
            // Ask if user wants to open the file
            const openFile = await electronAPI.dialog.showMessageBox({
                type: 'question',
                buttons: ['Open File', 'Show in Folder', 'Close'],
                defaultId: 0,
                message: 'Download Complete',
                detail: `${fileName} has been downloaded successfully. What would you like to do?`
            });
            
            if (openFile.response === 0) {
                await electronAPI.shell.openPath(localPath);
            } else if (openFile.response === 1) {
                await electronAPI.shell.showItemInFolder(localPath);
            }
        } else {
            throw new Error(result.error || 'Failed to download file');
        }
        
    } catch (error) {
        console.error('Error downloading file with progress:', error);
        showNotification(`Error mengunduh file: ${error.message}`, 'error');
    } finally {
        hideDownloadProgress();
        if (downloadProgressCleanup) {
            downloadProgressCleanup();
            downloadProgressCleanup = null;
        }
    }
}

function showDownloadProgress(fileName) {
    const progressHtml = `
        <div id="downloadProgressModal" class="modal" style="display: block;">
            <div class="modal-content">
                <div class="modal-header">
                    <h3>Downloading File</h3>
                </div>
                <div class="modal-body">
                    <p><strong>File:</strong> <span id="downloadFileName">${escapeHtml(fileName)}</span></p>
                    <div class="progress-container">
                        <div class="progress-bar">
                            <div id="downloadProgressBar" class="progress-fill" style="width: 0%"></div>
                        </div>
                        <div class="progress-info">
                            <span id="downloadProgressText">0%</span>
                            <span id="downloadSpeedText"></span>
                        </div>
                    </div>
                    <div class="download-details">
                        <div>Downloaded: <span id="downloadedBytes">0 B</span> / <span id="totalBytes">0 B</span></div>
                        <div>Status: <span id="downloadStatus">Preparing...</span></div>
                    </div>
                </div>
                <div class="modal-footer">
                    <button type="button" class="btn btn-secondary" onclick="cancelDownload()">Cancel</button>
                </div>
            </div>
        </div>
    `;
    
    document.body.insertAdjacentHTML('beforeend', progressHtml);
}

function updateDownloadProgress(data) {
    const progressBar = document.getElementById('downloadProgressBar');
    const progressText = document.getElementById('downloadProgressText');
    const downloadedBytes = document.getElementById('downloadedBytes');
    const totalBytes = document.getElementById('totalBytes');
    const downloadStatus = document.getElementById('downloadStatus');
    
    if (progressBar) progressBar.style.width = `${data.progress}%`;
    if (progressText) progressText.textContent = `${data.progress}%`;
    if (downloadedBytes) downloadedBytes.textContent = formatFileSize(data.downloaded);
    if (totalBytes) totalBytes.textContent = formatFileSize(data.total);
    if (downloadStatus) downloadStatus.textContent = data.status || 'Downloading...';
}

function hideDownloadProgress() {
    const modal = document.getElementById('downloadProgressModal');
    if (modal) {
        modal.remove();
    }
}

function cancelDownload() {
    hideDownloadProgress();
    if (downloadProgressCleanup) {
        downloadProgressCleanup();
        downloadProgressCleanup = null;
    }
    showNotification('Download cancelled', 'info');
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

function updateConfigModalForConnection() {
    // Show connect button and modify modal for connection mode
    const connectButton = document.getElementById('connectFtpButton');
    const saveButton = document.getElementById('saveConfig');
    const cancelButton = document.getElementById('cancelConfig');
    
    if (connectButton && saveButton) {
        connectButton.style.display = 'inline-block';
        saveButton.textContent = 'Simpan & Hubungkan';
        
        // Update modal header text
        const modalHeader = document.querySelector('.modal-header h2');
        if (modalHeader) {
            modalHeader.textContent = 'Konfigurasi FTP - Siap Terhubung';
        }
        
        const modalSubtext = document.querySelector('.modal-header p');
        if (modalSubtext) {
            modalSubtext.textContent = 'Konfigurasi ditemukan. Anda dapat memodifikasi pengaturan atau langsung terhubung.';
        }
    }
}

async function handleConnectFTP() {
    console.log('=== CONNECTING TO FTP SERVER ===');
    
    try {
        // Show loading indicator
        showLoading('Menghubungkan ke server FTP...');
        
        // Disable connect button during connection
        const connectButton = document.getElementById('connectFtpButton');
        if (connectButton) {
            connectButton.disabled = true;
            connectButton.textContent = '🔄 Menghubungkan...';
        }
        
        // Check if we have valid configuration
        if (!appState.config || !appState.config.ftp || !appState.config.ftp.host) {
            throw new Error('Konfigurasi FTP tidak valid. Silakan periksa pengaturan.');
        }
        
        console.log('Initializing FTP connection with caching system...');
        
        // Initialize connections with intelligent caching
        await initializeConnections();
        
        // Hide config modal and show main app
        hideConfigModal();
        hideLoading();
        
        // Show success notification
        showNotification('Berhasil terhubung ke server FTP!', 'success');
        
        console.log('FTP connection established successfully with caching enabled');
        
    } catch (error) {
        console.error('Error connecting to FTP:', error);
        
        // Re-enable connect button
        const connectButton = document.getElementById('connectFtpButton');
        if (connectButton) {
            connectButton.disabled = false;
            connectButton.textContent = '🔗 Hubungkan';
        }
        
        hideLoading();
        showNotification('Gagal terhubung: ' + error.message, 'error');
    }
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

// Skeleton screen functions
function showTreeSkeleton() {
    const tree = elements.ftpTree;
    tree.innerHTML = `
        <div class="skeleton-container">
            <div class="skeleton-tree-item">
                <div class="skeleton-icon"></div>
                <div class="skeleton-text medium"></div>
            </div>
            <div class="skeleton-tree-item">
                <div class="skeleton-icon"></div>
                <div class="skeleton-text short"></div>
            </div>
            <div class="skeleton-tree-item">
                <div class="skeleton-icon"></div>
                <div class="skeleton-text long"></div>
            </div>
            <div class="skeleton-tree-item">
                <div class="skeleton-icon"></div>
                <div class="skeleton-text medium"></div>
            </div>
            <div class="skeleton-tree-item">
                <div class="skeleton-icon"></div>
                <div class="skeleton-text short"></div>
            </div>
        </div>
    `;
}

function showFileListSkeleton() {
    const fileList = elements.ftpFileList;
    fileList.innerHTML = `
        <div class="skeleton-file-item">
            <div class="skeleton-file-icon"></div>
            <div class="skeleton-file-details">
                <div class="skeleton-file-name" style="width: 140px;"></div>
                <div class="skeleton-file-meta"></div>
            </div>
        </div>
        <div class="skeleton-file-item">
            <div class="skeleton-file-icon"></div>
            <div class="skeleton-file-details">
                <div class="skeleton-file-name" style="width: 180px;"></div>
                <div class="skeleton-file-meta"></div>
            </div>
        </div>
        <div class="skeleton-file-item">
            <div class="skeleton-file-icon"></div>
            <div class="skeleton-file-details">
                <div class="skeleton-file-name" style="width: 120px;"></div>
                <div class="skeleton-file-meta"></div>
            </div>
        </div>
        <div class="skeleton-file-item">
            <div class="skeleton-file-icon"></div>
            <div class="skeleton-file-details">
                <div class="skeleton-file-name" style="width: 200px;"></div>
                <div class="skeleton-file-meta"></div>
            </div>
        </div>
        <div class="skeleton-file-item">
            <div class="skeleton-file-icon"></div>
            <div class="skeleton-file-details">
                <div class="skeleton-file-name" style="width: 160px;"></div>
                <div class="skeleton-file-meta"></div>
            </div>
        </div>
    `;
}

function showDirectoryExpandSkeleton(childrenContainer) {
    childrenContainer.innerHTML = `
        <div class="skeleton-tree-item">
            <div class="skeleton-icon"></div>
            <div class="skeleton-text medium"></div>
        </div>
        <div class="skeleton-tree-item">
            <div class="skeleton-icon"></div>
            <div class="skeleton-text short"></div>
        </div>
        <div class="skeleton-tree-item">
            <div class="skeleton-icon"></div>
            <div class="skeleton-text long"></div>
        </div>
    `;
    childrenContainer.style.display = 'block';
}

function updateFTPStatus(connected) {
    appState.ftpConnected = connected;
    elements.ftpStatus.textContent = connected ? 'FTP: Connected' : 'FTP: Disconnected';
    elements.ftpStatus.className = `status-indicator ${connected ? 'connected' : ''}`;
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
        console.log('Refreshing all data with lazy loading...');
        
        // Stop background worker temporarily
        await electronAPI.ftp.stopBackgroundWorker();
        
        // Clear all lazy cache
        await electronAPI.ftp.clearLazyCache();
        
        // Refresh FTP cache with lazy loading
        await refreshFTPCache(true);
        
        // Restart background worker
        await electronAPI.ftp.startBackgroundWorker();
        
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

// =============================================
// Upload Functionality
// =============================================

let selectedFiles = [];
let uploadProgressCleanup = null;

// Initialize upload functionality
function initializeUploadFunctionality() {
    const uploadSection = document.getElementById('upload-section');
    const dropZone = document.getElementById('drop-zone');
    const fileInput = document.getElementById('file-input');
    const browseBtn = document.getElementById('browse-btn');
    const uploadBtn = document.getElementById('upload-btn');
    const clearBtn = document.getElementById('clear-btn');
    const selectedFilesList = document.getElementById('selected-files-list');
    const uploadProgress = document.getElementById('upload-progress');
    const progressBar = document.getElementById('progress-bar');
    const progressText = document.getElementById('progress-text');

    if (!uploadSection) return; // Upload UI not available

    // Drag and drop functionality
    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZone.classList.add('drag-over');
    });

    dropZone.addEventListener('dragleave', (e) => {
        e.preventDefault();
        if (!dropZone.contains(e.relatedTarget)) {
            dropZone.classList.remove('drag-over');
        }
    });

    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.classList.remove('drag-over');
        
        const files = Array.from(e.dataTransfer.files);
        addFilesToSelection(files);
    });

    // Browse button functionality
    browseBtn.addEventListener('click', async () => {
        try {
            const result = await window.electronAPI.dialog.openFiles();
            if (!result.cancelled && result.filePaths.length > 0) {
                const files = result.filePaths.map(path => ({ path }));
                addFilesToSelection(files);
            }
        } catch (error) {
            console.error('Error opening file dialog:', error);
            showNotification('Error opening file dialog', 'error');
        }
    });

    // Upload button functionality
    uploadBtn.addEventListener('click', async () => {
        if (selectedFiles.length === 0) {
            showNotification('Please select files to upload', 'warning');
            return;
        }

        await uploadSelectedFiles();
    });

    // Clear button functionality
    clearBtn.addEventListener('click', () => {
        selectedFiles = [];
        updateSelectedFilesList();
        hideUploadProgress();
    });

    // Setup upload progress listener
    if (uploadProgressCleanup) {
        uploadProgressCleanup();
    }
    uploadProgressCleanup = window.electronAPI.ftp.onUploadProgress((data) => {
        updateUploadProgress(data);
    });
}

function addFilesToSelection(files) {
    files.forEach(file => {
        const filePath = file.path || file.name;
        const fileName = filePath.split(/[\\/]/).pop();
        
        // Check if file already selected
        if (!selectedFiles.find(f => f.path === filePath)) {
            selectedFiles.push({
                path: filePath,
                name: fileName,
                size: file.size || 0
            });
        }
    });
    
    updateSelectedFilesList();
}

function updateSelectedFilesList() {
    const selectedFilesList = document.getElementById('selected-files-list');
    const uploadControls = document.querySelector('.upload-controls');
    
    if (selectedFiles.length === 0) {
        selectedFilesList.innerHTML = '<p class="no-files">No files selected</p>';
        uploadControls.style.display = 'none';
        return;
    }
    
    uploadControls.style.display = 'flex';
    
    selectedFilesList.innerHTML = selectedFiles.map((file, index) => `
        <div class="file-item">
            <div class="file-info">
                <span class="file-name">${escapeHtml(file.name)}</span>
                <span class="file-size">${formatFileSize(file.size)}</span>
            </div>
            <button class="remove-file-btn" onclick="removeFileFromSelection('${index}')">
                <i class="fas fa-times"></i>
            </button>
        </div>
    `).join('');
}

function removeFileFromSelection(index) {
    selectedFiles.splice(index, 1);
    updateSelectedFilesList();
}

async function uploadSelectedFiles() {
    if (!currentPath) {
        showNotification('Please navigate to a directory first', 'warning');
        return;
    }

    const uploadBtn = document.getElementById('upload-btn');
    const clearBtn = document.getElementById('clear-btn');
    
    try {
        uploadBtn.disabled = true;
        clearBtn.disabled = true;
        showUploadProgress();
        
        // Prepare files for upload
        const filesToUpload = selectedFiles.map(file => ({
            localPath: file.path,
            remotePath: currentPath + '/' + file.name
        }));
        
        const result = await window.electronAPI.ftp.uploadMultiple(filesToUpload);
        
        if (result.success) {
            showNotification(`Successfully uploaded ${selectedFiles.length} file(s)`, 'success');
            selectedFiles = [];
            updateSelectedFilesList();
            hideUploadProgress();
            
            // Refresh the current directory
            await loadDirectory(currentPath);
        } else {
            throw new Error(result.error || 'Upload failed');
        }
    } catch (error) {
        console.error('Upload error:', error);
        showNotification(`Upload failed: ${error.message}`, 'error');
        hideUploadProgress();
    } finally {
        uploadBtn.disabled = false;
        clearBtn.disabled = false;
    }
}

function showUploadProgress() {
    const uploadProgress = document.getElementById('upload-progress');
    uploadProgress.style.display = 'block';
    updateUploadProgress({ progress: 0, transferred: 0, total: 0 });
}

function hideUploadProgress() {
    const uploadProgress = document.getElementById('upload-progress');
    uploadProgress.style.display = 'none';
}

function updateUploadProgress(data) {
    const progressBar = document.getElementById('progress-bar');
    const progressText = document.getElementById('progress-text');
    
    const percentage = Math.round(data.progress || 0);
    progressBar.style.width = `${percentage}%`;
    
    if (data.transferred && data.total) {
        progressText.textContent = `${formatFileSize(data.transferred)} / ${formatFileSize(data.total)} (${percentage}%)`;
    } else {
        progressText.textContent = `${percentage}%`;
    }
}

// Delete functionality
let selectedItems = new Set();
let deleteProgressCleanup = null;

function initializeDeleteFunctionality() {
    const selectAllBtn = document.getElementById('selectAllBtn');
    const deselectAllBtn = document.getElementById('deselectAllBtn');
    const deleteSelectedBtn = document.getElementById('deleteSelectedBtn');
    
    if (selectAllBtn) {
        selectAllBtn.addEventListener('click', selectAllItems);
    }
    
    if (deselectAllBtn) {
        deselectAllBtn.addEventListener('click', deselectAllItems);
    }
    
    if (deleteSelectedBtn) {
        deleteSelectedBtn.addEventListener('click', deleteSelectedItems);
    }
    
    // Set up delete progress listener
    if (window.electronAPI && window.electronAPI.ftp.onDeleteProgress) {
        deleteProgressCleanup = window.electronAPI.ftp.onDeleteProgress((data) => {
            updateDeleteProgress(data);
        });
    }
}

function toggleDeleteControls(show) {
    const deleteControls = document.getElementById('deleteControls');
    if (deleteControls) {
        deleteControls.style.display = show ? 'flex' : 'none';
    }
}

function updateDeleteInfo() {
    const deleteInfo = document.getElementById('deleteInfo');
    const deleteBtn = document.getElementById('deleteSelectedBtn');
    
    if (deleteInfo) {
        const count = selectedItems.size;
        deleteInfo.textContent = count === 0 ? 'No items selected' : `${count} item${count > 1 ? 's' : ''} selected`;
    }
    
    if (deleteBtn) {
        deleteBtn.disabled = selectedItems.size === 0;
    }
}

function selectAllItems() {
    const fileItems = document.querySelectorAll('.file-item');
    selectedItems.clear();
    
    fileItems.forEach(item => {
        const checkbox = item.querySelector('.file-item-checkbox');
        if (checkbox) {
            checkbox.checked = true;
            item.classList.add('selected');
            
            const itemData = {
                name: item.dataset.name,
                path: item.dataset.path,
                type: item.dataset.type
            };
            selectedItems.add(JSON.stringify(itemData));
        }
    });
    
    updateDeleteInfo();
}

function deselectAllItems() {
    const fileItems = document.querySelectorAll('.file-item');
    selectedItems.clear();
    
    fileItems.forEach(item => {
        const checkbox = item.querySelector('.file-item-checkbox');
        if (checkbox) {
            checkbox.checked = false;
            item.classList.remove('selected');
        }
    });
    
    updateDeleteInfo();
}

function toggleItemSelection(item, checkbox) {
    const itemData = {
        name: item.dataset.name,
        path: item.dataset.path,
        type: item.dataset.type
    };
    const itemKey = JSON.stringify(itemData);
    
    if (checkbox.checked) {
        selectedItems.add(itemKey);
        item.classList.add('selected');
    } else {
        selectedItems.delete(itemKey);
        item.classList.remove('selected');
    }
    
    updateDeleteInfo();
}

async function deleteSelectedItems() {
    if (selectedItems.size === 0) return;
    
    const items = Array.from(selectedItems).map(item => JSON.parse(item));
    const itemNames = items.map(item => item.name).join(', ');
    
    // Show confirmation dialog
    const confirmed = await window.electronAPI.dialog.showConfirmation({
        title: 'Confirm Delete',
        message: `Are you sure you want to delete ${items.length} item${items.length > 1 ? 's' : ''}?`,
        detail: `Items to delete: ${itemNames}\n\nThis action cannot be undone.`
    });
    
    if (!confirmed.confirmed) return;
    
    try {
        showDeleteProgress();
        
        const result = await window.electronAPI.ftp.deleteMultiple(items);
        
        if (result.success) {
            showNotification(`Successfully deleted ${items.length} item${items.length > 1 ? 's' : ''}`, 'success');
            
            // Clear selection and refresh directory
            selectedItems.clear();
            updateDeleteInfo();
            hideDeleteProgress();
            
            // Refresh the current directory
            await loadDirectory(currentPath);
        } else {
            throw new Error(result.error || 'Delete operation failed');
        }
    } catch (error) {
        console.error('Delete error:', error);
        showNotification(`Delete failed: ${error.message}`, 'error');
        hideDeleteProgress();
    }
}

function showDeleteProgress() {
    const uploadSection = document.getElementById('uploadSection');
    if (!uploadSection) return;
    
    // Create delete progress element if it doesn't exist
    let deleteProgress = document.getElementById('delete-progress');
    if (!deleteProgress) {
        deleteProgress = document.createElement('div');
        deleteProgress.id = 'delete-progress';
        deleteProgress.className = 'delete-progress';
        deleteProgress.innerHTML = `
            <div class="delete-progress-header">
                <div class="delete-progress-title">Deleting Items...</div>
                <div class="delete-progress-stats" id="delete-progress-stats">0 / 0</div>
            </div>
            <div class="delete-progress-bar">
                <div class="delete-progress-fill" id="delete-progress-fill" style="width: 0%"></div>
            </div>
            <div class="delete-current-item" id="delete-current-item">Preparing...</div>
        `;
        uploadSection.appendChild(deleteProgress);
    }
    
    deleteProgress.style.display = 'block';
    updateDeleteProgress({ progress: 0, completed: 0, total: 0, currentItem: 'Preparing...' });
}

function hideDeleteProgress() {
    const deleteProgress = document.getElementById('delete-progress');
    if (deleteProgress) {
        deleteProgress.style.display = 'none';
    }
}

function updateDeleteProgress(data) {
    const progressFill = document.getElementById('delete-progress-fill');
    const progressStats = document.getElementById('delete-progress-stats');
    const currentItem = document.getElementById('delete-current-item');
    
    if (progressFill) {
        const percentage = data.progress || 0;
        progressFill.style.width = `${percentage}%`;
    }
    
    if (progressStats) {
        progressStats.textContent = `${data.completed || 0} / ${data.total || 0}`;
    }
    
    if (currentItem) {
        if (data.success === false && data.error) {
            currentItem.textContent = `Error: ${data.error}`;
            currentItem.style.color = '#dc2626';
        } else {
            currentItem.textContent = data.currentItem || 'Processing...';
            currentItem.style.color = '#374151';
        }
    }
}

// Make functions globally available
window.removeFileFromSelection = removeFileFromSelection;
window.initializeUploadFunctionality = initializeUploadFunctionality;
window.initializeDeleteFunctionality = initializeDeleteFunctionality;
window.toggleItemSelection = toggleItemSelection;
window.toggleDeleteControls = toggleDeleteControls;

// Initialize functionality when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        initializeUploadFunctionality();
        initializeDeleteFunctionality();
        initializeFileEditor();
    });
} else {
    initializeUploadFunctionality();
    initializeDeleteFunctionality();
    initializeFileEditor();
}
