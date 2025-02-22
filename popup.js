// 发送采集请求并等待响应
async function sendCollectRequest(idea = '') {
    try {
        // 检查是否在冷却时间内
        const now = Date.now();
        if (now - lastClickTime < COOLDOWN) {
            showStatus('请稍等片刻再试', 'error');
            return false;
        }
        lastClickTime = now;

        // 首先检查是否设置了 Webhook 地址
        const settings = await chrome.storage.sync.get(['feishuUrl']);
        if (!settings.feishuUrl) {
            showStatus('请先设置飞书 Webhook 地址', 'error');
            return false;
        }

        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        
        if (!tab) {
            showStatus('无法获取当前标签页', 'error');
            return false;
        }

        // 检查当前标签页是否可以注入content script
        try {
            // 首先尝试检查content script是否已经注入并响应
            const response = await chrome.tabs.sendMessage(tab.id, { action: 'ping' });
            if (!response || !response.pong) {
                throw new Error('Content script 未响应');
            }
            console.log('Content script 已经就绪');
        } catch (error) {
            console.log('Content script 未就绪，尝试重新注入');
            try {
                await chrome.scripting.executeScript({
                    target: { tabId: tab.id },
                    files: ['content.js']
                });
                // 等待content script加载
                await new Promise(resolve => setTimeout(resolve, 1000));
            } catch (injectError) {
                console.error('注入content script失败:', injectError);
                showStatus('无法在当前页面使用此功能', 'error');
                return false;
            }
        }

        // 发送采集请求
        const response = await chrome.tabs.sendMessage(tab.id, {
            action: 'collect',
            idea: idea
        });

        console.log('采集响应:', response);

        if (!response) {
            showStatus('未收到响应', 'error');
            return false;
        }

        // 如果返回错误消息，显示错误
        if (!response.success) {
            showStatus(response.message || '采集失败', 'error');
            return false;
        }

        // 清空输入框
        document.getElementById('ideaInput').value = '';
        showStatus('采集成功', 'success');
        
        return true;
    } catch (error) {
        console.error('发送采集请求失败:', error);
        if (error.message.includes('Receiving end does not exist')) {
            showStatus('页面未准备就绪，请刷新后重试', 'error');
        } else {
            showStatus(error.message || '发送采集请求失败', 'error');
        }
        return false;
    }
}

// 添加状态显示函数
function showStatus(message, type = 'info') {
    const statusElement = document.getElementById('status');
    if (!statusElement) return;

    statusElement.textContent = message;
    statusElement.className = `status ${type}`;
    
    // 3秒后自动清除
    setTimeout(() => {
        statusElement.textContent = '';
        statusElement.className = 'status';
    }, 3000);
}

// 修改事件监听器
document.addEventListener('DOMContentLoaded', () => {
    // 获取设置
    chrome.storage.sync.get(['feishuUrl'], function(result) {
        const urlInput = document.getElementById('feishuUrl');
        if (urlInput && result.feishuUrl) {
            urlInput.value = result.feishuUrl;
        }
    });

    // 保存按钮事件
    const saveButton = document.getElementById('saveButton');
    if (saveButton) {
        saveButton.addEventListener('click', async () => {
            const urlInput = document.getElementById('feishuUrl');
            const url = urlInput.value.trim();
            
            if (!url) {
                showStatus('请输入 Webhook 地址', 'error');
                return;
            }

            await chrome.storage.sync.set({ feishuUrl: url });
            showStatus('设置已保存', 'success');
        });
    }
});

// 移除 DEFAULT_SETTINGS 中的 cozeToken
const DEFAULT_SETTINGS = {};

// 修改设置加载部分
document.addEventListener('DOMContentLoaded', async () => {
    try {
        // 只获取飞书URL设置
        const settings = await chrome.storage.sync.get(['feishuUrl', 'isFirstInstall']);
        
        // 如果是首次安装
        if (settings.isFirstInstall === undefined) {
            await chrome.storage.sync.set({
                isFirstInstall: false
            });
        }

        // 设置飞书URL
        document.getElementById('feishuUrl').value = settings.feishuUrl || '';

        // 添加设置展开/折叠功能
        const toggleButton = document.querySelector('.toggle-settings');
        const settingsDiv = document.querySelector('.settings');
        
        toggleButton.addEventListener('click', () => {
            const isExpanded = settingsDiv.classList.toggle('expanded');
            toggleButton.classList.toggle('expanded', isExpanded);
        });
    } catch (error) {
        console.error('加载设置失败:', error);
    }

    document.getElementById('saveSettings').addEventListener('click', saveSettings);
});

// 显示通知
function showNotification(message, type = 'info') {
    const notification = document.createElement('div');
    notification.className = `notification ${type}`;
    notification.textContent = message;
    
    // 移除可能存在的旧通知
    const oldNotification = document.querySelector('.notification');
    if (oldNotification) {
        oldNotification.remove();
    }
    
    document.body.appendChild(notification);
    
    // 等待一帧以确保DOM更新
    requestAnimationFrame(() => {
        notification.classList.add('show');
    });

    // 3秒后隐藏通知
    setTimeout(() => {
        notification.classList.remove('show');
        setTimeout(() => notification.remove(), 3000);
    }, 3000);
}

// 状态管理
let lastClickTime = 0;
const COOLDOWN = 2000; // 2秒冷却时间

// 获取当前标签页
async function getCurrentTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab;
}

// 更新状态显示
function updateStatus(message) {
    const statusElement = document.getElementById('status');
    if (statusElement) {
        statusElement.textContent = message;
        setTimeout(() => {
            statusElement.textContent = '';
        }, 2000);
    }
}

// 修改收集按钮点击处理函数
async function handleCollectClick() {
    try {
        const tab = await getCurrentTab();
        if (!tab) {
            console.error('无法获取当前标签页');
            return;
        }
        
        // 获取用户输入的想法
        const ideaInput = document.getElementById('ideaInput');
        const idea = ideaInput ? ideaInput.value.trim() : '';
        
        console.log('准备发送采集请求，idea:', idea);
        
        // 发送消息到content script，包含想法
        const success = await sendCollectRequest(idea);
        if (success) {
            // 清空输入框
            if (ideaInput) {
                ideaInput.value = '';
            }
            window.close(); // 成功后关闭弹窗
        }
        
    } catch (error) {
        console.error('处理点击事件失败:', error);
        showStatus('操作失败，请重试', 'error');
    }
}

// 当popup页面加载完成时
document.addEventListener('DOMContentLoaded', () => {
    console.log('Popup页面加载完成');
    
    const collectBtn = document.getElementById('collectBtn');
    if (collectBtn) {
        console.log('找到收集按钮，添加事件监听器');
        collectBtn.addEventListener('click', handleCollectClick);
    } else {
        console.error('未找到收集按钮');
    }
});

// 确保只在popup页面关闭时清理
window.addEventListener('unload', () => {
    const collectBtn = document.getElementById('collectBtn');
    if (collectBtn) {
        collectBtn.removeEventListener('click', handleCollectClick);
    }
});

// 修改保存设置函数
async function saveSettings() {
    try {
        const feishuUrl = document.getElementById('feishuUrl').value.trim();
        if (!feishuUrl) {
            showStatus('请填写飞书 Webhook URL', 'error');
            return;
        }

        // 删除格式验证
        await chrome.storage.sync.set({ feishuUrl });
        showStatus('✓ 设置已更新', 'success');
    } catch (error) {
        console.error('保存设置失败:', error);
        showStatus('保存设置失败，请重试', 'error');
    }
}