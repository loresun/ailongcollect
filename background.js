// 创建右键菜单
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "saveToFeishu",
    title: "保存到飞书",
    contexts: ["selection"]  // 只在选中文本时显示
  });
});

// 处理右键菜单点击
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "saveToFeishu") {
    const selectedText = info.selectionText;
    
    // 检查是否有选中文本
    if (!selectedText) {
      console.error("没有选中文本");
      chrome.tabs.sendMessage(tab.id, {
          action: "showNotification",
          message: "请选择要保存的文本",
          type: "error"
      });
      return;
    }

    // 构建数据 - 添加统一的数据结构
    const data = {
      title: `摘录自: ${tab.title}`,
      url: tab.url,
      content: selectedText,
      idea: "", // 右键菜单暂时不包含想法
      metadata: {
        source: 'selection',
        selectionLength: selectedText.length,
        platform: "网页选择",
        userIdea: "", // 右键菜单暂时不包含想法
        authorUrl: "",
        // 添加社交数据字段，保持结构统一
        likes: null,
        comments: null,
        shares: null,
        collects: null,
        timestamp: new Date().toISOString()
      }
    };

    // 发送到飞书
    sendToFeishu(data, tab);
  }
});

// 速率限制器
class RateLimiter {
    constructor(maxRequests, interval) {
        this.maxRequests = maxRequests;
        this.interval = interval;
        this.queue = [];
        this.tokens = maxRequests;
        setInterval(() => {
            this.tokens = Math.min(this.tokens + 1, this.maxRequests);
            this.processQueue();
        }, interval);
    }

    async acquire() {
        return new Promise(resolve => {
            this.queue.push(resolve);
            this.processQueue();
        });
    }

    processQueue() {
        while (this.queue.length > 0 && this.tokens > 0) {
            this.tokens--;
            const resolve = this.queue.shift();
            resolve();
        }
    }
}

// 创建速率限制器（每秒最多2个请求）
const rateLimiter = new RateLimiter(2, 1000);

// 添加一个防重复处理的标志
let isProcessing = false;

// 添加重试机制的工具函数
async function retryOperation(operation, maxRetries = 3, delay = 1000) {
    let lastError;
    
    for (let i = 0; i < maxRetries; i++) {
        try {
            return await operation();
        } catch (error) {
            console.log(`尝试 ${i + 1}/${maxRetries} 失败:`, error);
            lastError = error;
            
            if (i < maxRetries - 1) {
                await new Promise(resolve => setTimeout(resolve, delay * (i + 1)));
            }
        }
    }
    
    throw lastError;
}

// 处理一般内容
async function processContent(info, sender) {
    try {
        console.log('Processing content:', info);
        
        // 构建要发送的数据
        const data = {
            title: info.title,
            url: info.url,
            content: info.content,
            idea: info.idea,
            metadata: {
                ...info.metadata,
                // 确保标签数据被包含
                tags: info.metadata.tags || [],
                // 其他元数据字段
                platform: info.metadata.platform || "网页",
                author: info.metadata.author || "未知作者",
                likes: info.metadata.likes || null,
                comments: info.metadata.comments || null,
                shares: info.metadata.shares || null,
                collects: info.metadata.collects || null,
                images: info.metadata.images || [],
                publishTime: info.metadata.publishTime || "",
                extractionTime: new Date().toISOString(),
                userIdea: info.metadata.userIdea || "",
                authorUrl: info.metadata.authorUrl || ""
            }
        };

        console.log('Sending data to Feishu:', data);
        
        // 发送到飞书
        const result = await sendToFeishu(data, sender.tab);
        return result;
        
    } catch (error) {
        console.error('处理内容时出错:', error);
        
        // 发送错误通知
        chrome.tabs.sendMessage(sender.tab.id, {
            action: "processingComplete",
            success: false,
            error: error.message
        });

        return { success: false, error: error.message };
    }
}

// 构建飞书消息格式
function buildFeishuMessage(data) {
    // 构建元数据摘要
    let metadataSummary = [];
    if (data.metadata) {
        if (data.metadata.author) metadataSummary.push(`作者: ${data.metadata.author}`);
        if (data.metadata.platform) metadataSummary.push(`平台: ${data.metadata.platform}`);
        if (data.metadata.publishTime) metadataSummary.push(`发布时间: ${data.metadata.publishTime}`);
        if (data.metadata.likes) metadataSummary.push(`点赞: ${data.metadata.likes}`);
        if (data.metadata.comments) metadataSummary.push(`评论: ${data.metadata.comments}`);
        if (data.metadata.shares) metadataSummary.push(`分享: ${data.metadata.shares}`);
        if (data.metadata.collects) metadataSummary.push(`收藏: ${data.metadata.collects}`);
        if (data.metadata.tags && data.metadata.tags.length > 0) {
            metadataSummary.push(`标签: ${data.metadata.tags.join(', ')}`);
        }
    }

    // 构建返回数据
    return {
        url: data.url || "",
        content: data.content || "",
        title: data.title || "",
        idea: data.idea || "",  // 确保 idea 字段存在
        summary: metadataSummary.join('\n'),  // 新增的摘要字段
        metadata: {
            author: data.metadata?.author || "未知作者",
            platform: data.metadata?.platform || "通用网页",
            paragraphCount: data.content?.split('\n').length || 0,
            images: data.metadata?.images || [],
            timestamp: new Date().toISOString(),
            likes: data.metadata?.likes || null,
            comments: data.metadata?.comments || null,
            shares: data.metadata?.shares || null,
            collects: data.metadata?.collects || null,
            tags: data.metadata?.tags || [],
            userIdea: data.idea || null,
            authorUrl: data.metadata && data.metadata.authorUrl ? data.metadata.authorUrl : "",
            publishTime: data.metadata?.publishTime || "",
            extractionTime: data.metadata?.extractionTime || ""
        }
    };
}

// 发送到飞书的函数
async function sendToFeishu(data, tab) {
    try {
        const webhookUrl = await getWebhookUrl();
        if (!webhookUrl) {
            throw new Error('未设置 Webhook 地址');
        }

        // 构建飞书消息格式
        const feishuMessage = buildFeishuMessage(data);

        // 使用重试机制发送请求
        const response = await retryOperation(async () => {
            return await fetch(webhookUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(feishuMessage)
            });
        }, 3, 1000);

        if (!response.ok) {
            throw new Error(`发送失败: ${response.status} ${response.statusText}`);
        }

        // 发送成功通知
        chrome.tabs.sendMessage(tab.id, {
            action: "processingComplete",
            success: true,
            message: '内容已成功保存到飞书'
        });

        return { success: true };
        
    } catch (error) {
        console.error('发送到飞书时出错:', error);
        
        // 发送错误通知
        chrome.tabs.sendMessage(tab.id, {
            action: "processingComplete",
            success: false,
            error: error.message
        });

        return { success: false, error: error.message };
    }
}

// 获取 webhook 地址的函数
async function getWebhookUrl() {
    const settings = await chrome.storage.sync.get(['feishuUrl']);
    return settings.feishuUrl;
}

// 修改消息监听器
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    console.log('Background received message:', request);
    
    if (request.action === 'processContent') {
        // 立即发送一个响应表示消息已收到
        sendResponse({ success: true, message: '正在处理...' });
        
        // 统一使用processContent处理所有内容
        processContent(request.info, sender)
            .then(result => {
                if (result.success) {
                    chrome.tabs.sendMessage(sender.tab.id, {
                        action: 'processingComplete',
                        success: true,
                        message: '内容已成功保存'
                    });
                } else {
                    throw new Error(result.error || '处理失败');
                }
            })
            .catch(error => {
                console.error('处理内容时出错:', error);
                chrome.tabs.sendMessage(sender.tab.id, {
                    action: 'processingComplete',
                    success: false,
                    error: error.message
                });
            });
        
        return true; // 保持消息通道开放
    }
    
    return false;
});
