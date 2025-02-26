console.log('content script 已加载');

// 全局状态管理
const ExtractManager = {
    state: {
        isInitialized: false,
        isCollecting: false,
        lastProcessTime: 0
    },

    initialize() {
        if (this.state.isInitialized) {
            console.log('ExtractManager 已经初始化');
            return;
        }

        console.log('ExtractManager 开始初始化');
        this.setupMessageListener();
        this.state.isInitialized = true;
        console.log('ExtractManager 初始化完成');
    },

    setupMessageListener() {
        chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
            console.log('收到消息:', request);

            if (!request || !request.action) {
                console.error('无效的消息格式');
                sendResponse({ success: false, message: '无效的消息格式' });
                return false;
            }

            // 添加对 ping 消息的处理
            if (request.action === "ping") {
                sendResponse({ pong: true });
                return false;
            }

            if (request.action === "collect" || request.action === "extract") {
                // 处理异步请求，保持消息通道开放
                (async () => {
                    try {
                        const response = await this.handleExtractRequest(request);
                        sendResponse(response);
                    } catch (error) {
                        console.error('处理请求失败:', error);
                        sendResponse({ success: false, message: error.message });
                    }
                })();
                return true; // 保持消息通道开放
            }

            if (request.action === "processingComplete") {
                showNotification(
                    request.success ? (request.message || '内容已成功保存') : (request.error || '保存失败'),
                    request.success ? 'success' : 'error'
                );
                return false;
            }

            return false;
        });
    },

    async handleExtractRequest(request, sendResponse) {
        // 检查冷却时间
        const now = Date.now();
        if (now - this.state.lastProcessTime < 3000) {
            console.log('请等待3秒后再试');
            return { success: false, message: '请等待3秒后再试' };
        }

        try {
            // 更新最后处理时间
            this.state.lastProcessTime = now;

            // 提取内容
            const info = await extractContent();
            if (info) {
                // 确保 idea 被正确设置
                if (request.action === "collect") {
                    info.idea = request.idea || '';
                    if (info.metadata) {
                        info.metadata.userIdea = request.idea || '';
                    }
                }

                // 发送到后台处理
                return new Promise((resolve) => {
                    chrome.runtime.sendMessage({
                        action: 'processContent',
                        info: info
                    }, response => {
                        if (chrome.runtime.lastError) {
                            console.error('发送消息失败:', chrome.runtime.lastError);
                            resolve({ success: false, message: chrome.runtime.lastError.message });
                            return;
                        }
                        resolve({ success: true, message: '开始处理...' });
                    });
                });
            }

            return { success: true, message: '开始处理...' };
        } catch (error) {
            console.error('处理内容时出错:', error);
            return { success: false, message: error.message };
        }
    }
};

// 初始化
console.log('content script 已加载');
ExtractManager.initialize();

// 添加通用内容清理函数
function cleanContent(text) {
    if (!text) return '';
    return text
        .replace(/\s+/g, ' ')
        .replace(/[\u200B-\u200D\uFEFF]/g, '')  // 删除零宽字符
        .replace(/\n\s*\n\s*\n/g, '\n\n')  // 删除多余的空行
        .trim();
}

// 添加高级内容提取函数
function extractMainContent(element) {
    if (!element) {
        console.error('未提供有效的内容元素');
        return '';
    }
    
    // 创建元素的克隆，避免修改原始DOM
    const contentElement = element.cloneNode(true);
    
    // 移除不需要的元素
    const selectorsToRemove = [
        'script', 'style', 'iframe', 'nav', 'header', 'footer',
        '.advertisement', '.comment', '.sidebar', '.menu', '.nav',
        '[role="complementary"]', '[role="navigation"]',
        'form', 'button', 'input', '.social-share',
        '.related-articles', '.recommended', '#comments',
        '.cookie-notice', '.popup', '.modal', '.overlay'
    ];
    
    try {
        selectorsToRemove.forEach(selector => {
            contentElement.querySelectorAll(selector).forEach(el => el.remove());
        });
        
        // 移除空白节点和注释节点
        const nodeIterator = document.createNodeIterator(
            contentElement,
            NodeFilter.SHOW_COMMENT | NodeFilter.SHOW_TEXT,
            null
        );
        
        let node;
        const nodesToRemove = [];
        while (node = nodeIterator.nextNode()) {
            if (node.nodeType === Node.COMMENT_NODE || 
                (node.nodeType === Node.TEXT_NODE && node.textContent.trim() === '')) {
                nodesToRemove.push(node);
            }
        }
        nodesToRemove.forEach(node => node.remove());
        
        // 获取所有文本节点
        const textNodes = [];
        const walk = document.createTreeWalker(
            contentElement,
            NodeFilter.SHOW_TEXT,
            {
                acceptNode: function(node) {
                    // 过滤掉隐藏元素的文本
                    const style = window.getComputedStyle(node.parentElement);
                    if (style.display === 'none' || style.visibility === 'hidden') {
                        return NodeFilter.FILTER_REJECT;
                    }
                    return NodeFilter.FILTER_ACCEPT;
                }
            }
        );
        
        while (node = walk.nextNode()) {
            const text = node.textContent.trim();
            if (text.length > 0) {
                // 获取父元素的字体大小，用于评估文本重要性
                const style = window.getComputedStyle(node.parentElement);
                const fontSize = parseInt(style.fontSize);
                textNodes.push({
                    text,
                    parentElement: node.parentElement,
                    fontSize: fontSize || 16, // 默认字体大小
                    weight: calculateTextWeight(text, node.parentElement)
                });
            }
        }
        
        // 按权重排序并过滤文本内容
        const sortedContent = textNodes
            .sort((a, b) => b.weight - a.weight)
            .filter(({ text, parentElement, weight }) => {
                // 排除无意义的短文本
                if (text.length < 10 && weight < 2) return false;
                
                // 排除导航链接等
                if (parentElement.tagName === 'A' && text.length < 100) return false;
                
                // 排除可能的菜单项
                if (text.length < 20 && parentElement.tagName === 'LI') return false;
                
                // 排除日期、时间等短文本
                if (text.match(/^\d{1,2}[:\/]\d{1,2}([:\/]\d{1,2})?$/)) return false;
                
                return true;
            })
            .map(({ text }) => cleanContent(text));
        
        // 去重并合并文本
        const uniqueContent = Array.from(new Set(sortedContent));
        
        // 如果内容太少，可能是提取失败
        if (uniqueContent.join('\n').length < 100) {
            console.warn('提取的内容太少，可能不是有效的文章页面');
            return '';
        }
        
        return uniqueContent.join('\n\n');
    } catch (error) {
        console.error('提取内容时出错:', error);
        return '';
    }
}

// 改进的文本权重计算函数
function calculateTextWeight(text, element) {
    if (!text || !element) return 0;
    
    let weight = 0;
    const textLength = text.trim().length;
    
    // 基础文本长度权重
    weight += Math.min(textLength / 100, 10); // 最多10分
    
    // 标题标签权重
    const headingTags = ['H1', 'H2', 'H3', 'H4', 'H5', 'H6'];
    if (headingTags.includes(element.tagName)) {
        weight += (7 - headingTags.indexOf(element.tagName)) * 2;
    }
    
    // 文本位置权重
    const rect = element.getBoundingClientRect();
    if (rect.top > 0 && rect.top < window.innerHeight) {
        weight += 3; // 首屏内容加权
    }
    
    // 段落密度权重
    const paragraphDensity = text.split(/[。！？.!?]/).length;
    weight += Math.min(paragraphDensity / 5, 5);
    
    // 特殊标记权重
    const className = element.className.toLowerCase();
    const id = element.id.toLowerCase();
    const keywords = ['content', 'article', 'post', 'text', 'main', 'body'];
    keywords.forEach(keyword => {
        if (className.includes(keyword) || id.includes(keyword)) {
            weight += 5;
        }
    });
    
    // 减分项
    const negativeKeywords = ['comment', 'sidebar', 'footer', 'header', 'nav', 'menu', 'ad', 'copyright'];
    negativeKeywords.forEach(keyword => {
        if (className.includes(keyword) || id.includes(keyword)) {
            weight -= 5;
        }
    });
    
    // 文本质量权重
    const textQuality = text.split(/\s+/).length / text.length;
    weight += textQuality * 5;
    
    // 图文混排权重
    const hasImages = element.getElementsByTagName('img').length > 0;
    if (hasImages) {
        weight += 3;
    }
    
    return Math.max(weight, 0); // 确保权重不为负
}

// 修改 extractSocialMetadata 函数中的小红书部分
function extractSocialMetadata() {
    const hostname = window.location.hostname;
    const metadata = {};
    
    if (hostname.includes('douyin.com')) {
        // 提取抖音数据 - 更新选择器以匹配新的结构
        const interactionSelectors = {
            // 点赞数 - 第一个数字
            likes: '.oYTywyxr:nth-of-type(1)',
            // 评论数 - 第二个数字
            comments: '.oYTywyxr:nth-of-type(2)', 
            // 收藏数 - 第三个数字
            collects: '.oYTywyxr:nth-of-type(3)',
            // 分享数 - 最后一个数字
            shares: '.Vc7Hm_bN'
        };

        // 遍历所有可能的选择器
        Object.entries(interactionSelectors).forEach(([key, selector]) => {
            const element = document.querySelector(selector);
            metadata[key] = element ? element.textContent.trim() : '0';
        });

        // 提取发布时间
        const publishTimeElement = document.querySelector('.MsN3XzkF');
        if (publishTimeElement) {
            metadata.publishTime = publishTimeElement.textContent.replace('发布时间：', '').trim();
        }

        // 提取标题文本
        const titleElement = document.querySelector('h1.idrZUbq7');
        if (titleElement) {
            metadata.rawContent = titleElement.textContent.trim();
        }
        
        // 提取标签
        const tags = Array.from(document.querySelectorAll('h1.idrZUbq7 .SLdJu_MF'))
            .map(tag => tag.textContent.trim())
            .filter(Boolean);
            
        metadata.platform = '抖音';
        metadata.tags = tags;
    } 
    else if (hostname.includes('xiaohongshu.com')) {
        try {
            // 更新选择器以匹配最新的DOM结构
            const selectors = {
                likes: [
                    '#noteContainer div[class="input-box"] span[data-v-e5195060].count',
                    '#noteContainer div[class*="like"] span.count',
                    '#noteContainer div[class*="like"] span[class*="number"]',
                    '#noteContainer .like-wrapper .count'
                ],
                collects: [
                    '#noteContainer span[data-v-502c7b76].count',
                    '#noteContainer div[class*="collect"] span.count',
                    '#noteContainer div[class*="collect"] span[class*="number"]',
                    '#noteContainer .collect-wrapper .count'
                ],
                comments: [
                    '#noteContainer span[data-v-3eeaf146].count',
                    '#noteContainer div[class*="comment"] span.count',
                    '#noteContainer div[class*="comment"] span[class*="number"]',
                    '#noteContainer .chat-wrapper .count'
                ]
            };

            // 使用选择器数组尝试获取数据
            const getValueFromSelectors = (selectorArray) => {
                for (const selector of selectorArray) {
                    const element = document.querySelector(selector);
                    if (element && element.textContent) {
                        return element.textContent.trim();
                    }
                }
                return '0';
            };

            // 获取互动数据
            const likeCount = getValueFromSelectors(selectors.likes);
            const collectCount = getValueFromSelectors(selectors.collects);
            const commentCount = getValueFromSelectors(selectors.comments);
            
            // 更新作者选择器
            const authorSelectors = [
                '#noteContainer div[class*="author-container"] span[class="username"]',
                '#noteContainer span[data-v-94644b26].username',
                '#noteContainer .user-info .username',
                '#noteContainer .author-info .username',
                '#noteContainer span[class*="username"]:not(.footer *)',
                '#noteContainer .user-name:not(.footer *)',
                '#noteContainer .author-name:not(.footer *)'
            ];
            
            let author = '未知作者';
            let authorUrl = '';
            for (const selector of authorSelectors) {
                const element = document.querySelector(selector);
                if (element && element.textContent.trim()) {
                    author = element.textContent.trim();
                    // 查找最近的 a 标签
                    const linkElement = element.closest('a[href*="/user/profile/"]');
                    if (linkElement) {
                        authorUrl = linkElement.href;
                    }
                    break;
                }
            }

            // 更新发布时间选择器
            const timeSelectors = [
                'span[data-v-cd6ca71e].date',
                'span[class*="date"]',
                'span[class*="time"]',
                '.publish-time',
                '.create-time'
            ];
            
            let publishTime = '';
            for (const selector of timeSelectors) {
                const element = document.querySelector(selector);
                if (element && element.textContent.trim()) {
                    publishTime = element.textContent.trim();
                    break;
                }
            }

            // 更新图片选择器
            const imageSelectors = [
                'img[data-xhs-img]',
                'img.note-slider-img',
                '.note-content img',
                '.content img',
                'div[class*="note"] img',
                'div[class*="content"] img'
            ];
            
            const images = [];
            for (const selector of imageSelectors) {
                const imgElements = document.querySelectorAll(selector);
                if (imgElements.length > 0) {
                    imgElements.forEach(img => {
                        if (img.src && 
                            !img.src.includes('data:image') && 
                            !img.src.includes('avatar') &&
                            !images.some(i => i.url === img.src)) {
                            images.push({
                                url: img.src,
                                width: img.naturalWidth || 0,
                                height: img.naturalHeight || 0,
                                alt: img.alt || ''
                            });
                        }
                    });
                    if (images.length > 0) break;
                }
            }

            // 更新标签选择器
            const tagSelectors = [
                'a[class*="tag"]',
                '.tag-container .tag',
                '.content a[href^="/tag"]',
                'span[class*="tag"]'
            ];
            
            const tags = new Set();
            for (const selector of tagSelectors) {
                const elements = document.querySelectorAll(selector);
                elements.forEach(element => {
                    const tag = element.textContent.trim();
                    if (tag.startsWith('#')) {
                        tags.add(tag.substring(1));
                    } else {
                        tags.add(tag);
                    }
                });
            }

            // 更新正文选择器
            const contentSelectors = [
                'div[class*="content"]',
                '.note-content',
                'div[class*="desc"]',
                'div[class*="text"]'
            ];
            
            let noteText = '';
            for (const selector of contentSelectors) {
                const element = document.querySelector(selector);
                if (element && element.textContent.trim()) {
                    noteText = element.textContent.trim();
                    break;
                }
            }

            metadata.likes = likeCount;
            metadata.collects = collectCount;
            metadata.comments = commentCount;
            metadata.author = author;
            metadata.authorUrl = authorUrl;
            metadata.publishTime = publishTime;
            metadata.images = images;
            metadata.platform = '小红书';
            metadata.tags = Array.from(tags);
            metadata.rawContent = noteText;
            metadata.source = 'xiaohongshu.com';
            metadata.extractionTime = new Date().toISOString();

            console.log('实时获取的小红书数据:', {
                author,
                likes: likeCount,
                collects: collectCount,
                comments: commentCount,
                publishTime,
                tagsCount: tags.size,
                tags: Array.from(tags),
                hasContent: !!noteText,
                imagesCount: images.length
            });
        } catch (error) {
            console.error('提取小红书数据时出错:', error);
            // 设置默认值
            metadata.likes = '0';
            metadata.collects = '0';
            metadata.comments = '0';
            metadata.author = '未知作者';
            metadata.authorUrl = '';
            metadata.platform = '小红书';
            metadata.tags = [];
            metadata.rawContent = '';
            metadata.images = [];
        }
    }
    
    return metadata;
}

// 修改 extractGeneralContent 函数
async function extractGeneralContent() {
    console.log('使用通用提取方法');
    const title = document.title.trim();
    const url = window.location.href;
    
    let content = '';
    let mainContent = null;
    
    if (window.location.hostname.includes('douyin.com')) {
        // 抖音特殊处理 - 只提取标题文本
        const titleElement = document.querySelector('h1.idrZUbq7');
        content = titleElement ? titleElement.textContent.trim() : '';
    } 
    else if (window.location.hostname.includes('xiaohongshu.com')) {
        // 小红书特殊处理
        mainContent = document.querySelector('#detail-desc .note-text');
        content = mainContent ? mainContent.textContent.trim() : '';
        
        // 如果找不到内容，尝试其他选择器
        if (!content) {
            mainContent = document.querySelector('.content, .desc');
            content = mainContent ? mainContent.textContent.trim() : '';
        }
    } 
    else {
        // 其他网站的通用处理...
        mainContent = document.querySelector('main') || 
                     document.querySelector('article') || 
                     document.querySelector('.article') ||
                     document.querySelector('.content') || 
                     document.body;
        content = extractMainContent(mainContent);
    }

    // 获取作者信息
    let author = '未知作者';
    if (window.location.hostname.includes('xiaohongshu.com')) {
        // 优先从小红书特定逻辑中获取作者信息
        const socialMetadata = extractSocialMetadata();
        author = socialMetadata.author || '未知作者';
    } else {
        // 原有的作者提取逻辑...
        author = document.querySelector('meta[name="author"]')?.content || author;
    }

    // 获取元数据
    const metaTags = {
        description: document.querySelector('meta[name="description"]')?.content || '',
        keywords: document.querySelector('meta[name="keywords"]')?.content || '',
        publishDate: document.querySelector('meta[property="article:published_time"]')?.content || '',
        author: author
    };

    // 获取社交平台特定的元数据
    const socialMetadata = extractSocialMetadata();

    // 返回提取的内容
    return {
        title,
        url,
        content: content,
        metadata: {
            ...metaTags,
            ...socialMetadata,
            author,
            extractionTime: new Date().toISOString(),
            hostname: window.location.hostname,
            readingTime: Math.ceil(content.split(/\s+/).length / 200)
        }
    };
}

// 修改 extractContent 函数
async function extractContent() {
    console.log('开始提取页面内容');
    
    try {
        const hostname = window.location.hostname;
        
        // 检测 DeepSeek 聊天页面
        if (hostname === 'chat.deepseek.com' || hostname.includes('deepseek.com')) {
            console.log('检测到DeepSeek页面，直接调用专用提取方法');
            return await extractDeepSeekContent();
        }
        
        // 直接检测特定网站，确保能正确处理
        if (hostname === 'web.okjike.com') {
            console.log('检测到即刻网站，直接调用专用提取方法');
            return await extractJikeContent();
        }
        
        // 检测知识星球网站
        if (hostname.includes('zsxq.com')) {
            console.log('检测到知识星球网站，直接调用专用提取方法');
            return await extractZsxqContent();
        }
        
        const result = await ExtractorManager.extract(hostname);
        
        // 确保返回的数据中包含必要字段
        if (!result.idea) {
            result.idea = '';
        }
        
        if (!result.metadata) {
            result.metadata = {};
        }
        result.metadata.userIdea = result.idea;
        
        console.log('本次提取结果:', result);
        return result;
        
    } catch (error) {
        console.error('提取内容出错:', error);
        return handleExtractError(error, window.location.hostname);
    }
}

// 处理提取错误的函数
function handleExtractError(error, platform) {
    console.error(`提取${platform}内容失败:`, error);
    showNotification(`提取${platform}内容失败，请稍后重试`, 'error');
    return null;
}

// 显示通知的函数
function showNotification(message, type = 'info') {
    console.log('显示通知:', message, type); // 添加日志
    
    // 移除已有的通知
    const existingNotification = document.querySelector('.custom-notification');
    if (existingNotification) {
        existingNotification.remove();
    }

    // 创建通知元素
    const notification = document.createElement('div');
    notification.className = `custom-notification ${type}`;
    
    // 设置样式 - 所有尺寸缩小为原来的一半
    notification.style.cssText = `
        position: fixed;
        top: 8px;
        left: 50%;
        transform: translateX(-50%);
        padding: 18px 36px;
        border-radius: 6px;
        z-index: 10000;
        font-size: 21px;
        font-weight: 500;
        background-color: #4CAF50;
        color: white;
        box-shadow: 0 3px 12px rgba(76, 175, 80, 0.3);
        transition: opacity 0.3s ease;
        text-align: center;
        min-width: 150px;
    `;

    // 设置文本
    notification.textContent = message;

    // 根据类型设置样式
    switch (type) {
        case 'success':
            notification.style.backgroundColor = '#4CAF50';
            notification.style.color = 'white';
            break;
        case 'error':
            notification.style.backgroundColor = '#f56c6c';
            notification.style.color = 'white';
            break;
        default:
            notification.style.backgroundColor = '#4CAF50';
            notification.style.color = 'white';
    }

    // 添加到页面
    document.body.appendChild(notification);

    // 3秒后自动消失
    setTimeout(() => {
        notification.style.opacity = '0';
        setTimeout(() => notification.remove(), 300);
    }, 3000);
}

// 获取活跃视频信息的函数
function getActiveVideoInfo() {
    console.log('开始获取视频信息');
    
    try {
        // 获取当前URL
        const currentUrl = window.location.href;
        
        // 优先检查是否是抖音视频页面
        if (currentUrl.match(/^https?:\/\/(www\.)?douyin\.com\/video\//)) {
            console.log('检测到抖音视频页面，使用专门的处理逻辑');
            
            // 尝试获取视频信息
            const titleElement = document.querySelector('.video-info-detail .title, .video-title-detail');
            const authorElement = document.querySelector('.video-info-detail .author-name, .author-name');
            const likeElement = document.querySelector('.video-info-detail .like-count, .praise-count');
            
            const pageTitle = titleElement ? titleElement.innerText.trim() : document.title;
            const author = authorElement ? authorElement.innerText.trim() : '未知用户';
            const likes = likeElement ? likeElement.innerText.trim() : '0';
            
            return {
                title: pageTitle,
                url: currentUrl.split('?')[0], // 移除查询参数
                metadata: {
                    author: author,
                    likes: likes,
                    platform: '抖音',
                    timestamp: new Date().toISOString()
                }
            };
        }
        
        // 如果不是视频页面，使用原有的处理逻辑
        // 获取活跃视频元素
        const videoDomAll = document.querySelectorAll([
            'video',
            
            // 抖音特定选择器
            '.xg-video-container video',
            '.video-player-video video',
            '.player-container video',
            '.swiper-slide-active video',
            '[data-e2e="feed-active-video"] video',
            '.feed-container video[autoplay]',
            '.video-card-container video',
            '.live-player-container video',
            
            // 新版抖音播放器容
            '.vqN35AZ4.basePlayerContainer video',
            '.pMZsZmuc.TYOxWsbM video',
            '.UwvcKsMK video',                 
            '.swiper-slide-active .xgplayer video',
            '[data-e2e="video-player"] video',
            
            // 新增更多视频容器选择器
            '.xg-video-container .xgplayer video',  // xgplayer视频播放器
            '.video-player-container video',        // 通用视频播放器容器
            '.swiper-slide-active .xg-video-container video', // 轮播中的视频
            '.player-wrapper video',               // 通用播放器包装器
            '.video-detail video',                // 视频详情页
            '.feed-item-content video',           // Feed流视频内容
            '[data-type="video"] video',          // 带有video类型标记的容器
            '.video-box video',                   // 视频盒子容器
            '.fullscreen-video video'             // 全视频容器
        ].join(','));

        if (videoDomAll.length === 0) {
            throw new Error('未找到视频元素');
        }
        
        // 筛选自动播放的视频
        const videoAll = Array.from(videoDomAll).filter(video => {
            // 检查自动播放属性
            const hasAutoplay = video.getAttribute('autoplay') !== null;
            // 检查视频是否正在播放
            const isPlaying = !video.paused;
            // 检查视频是否可见
            const isVisible = video.offsetWidth > 0 && video.offsetHeight > 0;
            // 检查是否在视口内
            const rect = video.getBoundingClientRect();
            const isInViewport = rect.top >= 0 && rect.left >= 0 && 
                               rect.bottom <= window.innerHeight && 
                               rect.right <= window.innerWidth;
            
            return (hasAutoplay || isPlaying) && isVisible && isInViewport;
        });

        // 获取当前活跃的视频容器
        const videoContainer = location.href.includes('modal_id') ? 
            videoAll[0] : videoAll[videoAll.length-1];

        if (!videoContainer) {
            throw new Error('未找到活跃视频容器');
        }

        // 获取视频相关信息的容器
        const activeVideoContainer = videoContainer.closest('[data-e2e="feed-active-video"]');
        if (!activeVideoContainer) {
            // 检查是否是抖音视频页面
            if (currentUrl.match(/^https?:\/\/(www\.)?douyin\.com\/video\//)) {
                console.log('抖音视频页面：未找到视频信息容器，使用页面信息');
                const pageTitle = document.title;
                return {
                    title: pageTitle,
                    url: currentUrl,
                    metadata: {
                        author: document.querySelector('.author-info .account-name, .author-name')?.innerText.trim() || '未知用户',
                        likes: document.querySelector('.like-count, .praise-count, ._9Qe0Zvm4')?.innerText.trim() || '0',
                        platform: '抖音',
                        timestamp: new Date().toISOString()
                    },
                    isDouyinFallback: true  // 标记这是抖音页面的备用处理
                };
            }
            throw new Error('未找到视频信息容');
        }

        // 获取标题
        const titleElement = activeVideoContainer.querySelector('.title');
        const title = titleElement ? titleElement.innerText.trim() : '';

        // 获取作者信息
        const authorElement = activeVideoContainer.querySelector('.account-name');
        const username = authorElement ? authorElement.innerText.trim() : '';

        // 获取点赞数
        const likeElement = activeVideoContainer.querySelector('.like-count, .praise-count');
        const likecount = likeElement ? likeElement.innerText.trim() : '0';

        // 使用当前URL（如果是视频页面）或构造新URL
        const videoUrl = currentUrl.match(/^https?:\/\/(www\.)?douyin\.com\/video\//) ? 
            currentUrl.split('?')[0] : // 移除任何查询参数
            `https://www.douyin.com/video/${activeVideoContainer.getAttribute('data-e2e-vid')}`;

        const info = {
            title: title || `抖音视频_${new Date().getTime()}`,
            url: videoUrl,
            metadata: {
                author: username || '未知用户',
                likes: likecount,
                platform: '抖音',
                timestamp: new Date().toISOString()
            }
        };

        console.log('获取到的视频信息:', info);
        return info;

    } catch (error) {
        console.error('获取视频信息失败:', error);
        throw error;
    }
}

// 添加即刻内容提取函数
async function extractJikeContent() {
    try {
        console.log('检测到即刻文章，使专用提取方法');

        // 等待内容加载
        await new Promise(resolve => setTimeout(resolve, 1000));

        // 获取作者信息
        const author = document.querySelector('.text-web-subtitle-3 a')?.textContent?.trim() ||
                      document.querySelector('.author-name')?.textContent?.trim() ||
                      '未知作者';

        // 获取发布时间
        const publishTime = document.querySelector('time')?.textContent?.trim() || '';

        // 获取正文内容
        const contentDiv = document.querySelector('.break-words.content_truncate__tFX8J') ||
                         document.querySelector('.post-content');
        
        // 处理内容，包括提取超链接
        let content = '';
        let processedContent = '';
        
        if (contentDiv) {
            // 先获取原始文本内容
            content = contentDiv.textContent.trim();
            
            // 创建一个副本用于处理
            const contentClone = contentDiv.cloneNode(true);
            
            // 处理所有超链接，将链接URL添加到文本中
            const links = contentClone.querySelectorAll('a');
            links.forEach(link => {
                // 检查是否是外部链接
                if (link.href && 
                    link.href.startsWith('http') && 
                    !link.href.includes('okjike.com') &&
                    link.getAttribute('target') === '_blank') {
                    
                    // 创建一个新的文本节点，包含链接URL
                    const linkText = document.createTextNode(` [${link.href}] `);
                    
                    // 在链接元素后插入链接URL
                    if (link.nextSibling) {
                        link.parentNode.insertBefore(linkText, link.nextSibling);
                    } else {
                        link.parentNode.appendChild(linkText);
                    }
                }
            });
            
            // 获取处理后的文本内容
            processedContent = contentClone.textContent.trim();
        }

        // 获取话题标签
        const topics = Array.from(document.querySelectorAll('a[href^="/topic/"]'))
            .map(tag => tag.textContent.trim())
            .filter(Boolean);

        // 获取互动数据
        const likes = document.querySelector('.text-tint-icon-gray span')?.textContent?.trim() || '0';
        const comments = document.querySelector('.comment-count')?.textContent?.trim() || '0';
        const reposts = document.querySelector('.repost-count')?.textContent?.trim() || '0';

        // 获取图片
        const images = [];
        const imgElements = contentDiv?.querySelectorAll('img') || [];
        imgElements.forEach(img => {
            if (img.src && !img.src.includes('data:image') && !img.src.includes('avatar')) {
                images.push({
                    url: img.src,
                    width: img.naturalWidth || 0,
                    height: img.naturalHeight || 0,
                    alt: img.alt || ''
                });
            }
        });
        
        // 获取所有外部链接
        const externalLinks = [];
        const linkElements = contentDiv?.querySelectorAll('a[target="_blank"]') || [];
        linkElements.forEach(link => {
            if (link.href && 
                link.href.startsWith('http') && 
                !link.href.includes('okjike.com')) {
                externalLinks.push({
                    text: link.textContent.trim(),
                    url: link.href
                });
            }
        });

        // 构造返回数据
        const extractedData = {
            title: content?.split('\n')[0] || '无标题', // 使用第一行作为标题
            url: window.location.href,
            content: cleanContent(processedContent || content), // 使用处理后的内容
            metadata: {
                author: cleanContent(author),
                publishTime: cleanContent(publishTime),
                platform: '即刻',
                topics: topics,
                source: 'web.okjike.com',
                paragraphCount: content.split('\n\n').length,
                images: images,
                externalLinks: externalLinks, // 添加外部链接数据
                interactions: {
                    likes: likes,
                    comments: comments,
                    reposts: reposts
                },
                timestamp: new Date().toISOString()
            }
        };

        console.log('提取的即刻内容:', extractedData);
        return extractedData;

    } catch (error) {
        console.error('提取即刻内容时出错:', error);
        throw new Error('提取即刻内容失败: ' + error.message);
    }
}

// 移除重复的 sendToFeishu 函数实现，改为发送消息给 background
async function handleExtractedContent(extractedData) {
    try {
        // 显示处理中的通知
        showNotification('正保存到飞书...', 'info');
        
        // 发送消息给 background.js 处理
        chrome.runtime.sendMessage({
            action: "sendToFeishu",
            data: extractedData
        });
        
    } catch (error) {
        console.error('处理提取内容时出错:', error);
        showNotification('发送内容失败，请重试', 'error');
    }
}

// 添加知乎内容提取函数
async function extractZhihuContent() {
    try {
        // 获取标题
        let title = document.querySelector('.QuestionHeader-title')?.textContent || 
                   document.querySelector('h1.Post-Title')?.textContent ||
                   document.querySelector('h1.QuestionHeader-title')?.textContent ||
                   document.title;

        // 获取作者
        let author = document.querySelector('.AuthorInfo-name')?.textContent || 
                    document.querySelector('.PostIndex-author')?.textContent || 
                    '';

        // 获取内容
        let content = '';
        
        // 问题描述
        const questionContent = document.querySelector('.QuestionRichText')?.textContent || '';
        if (questionContent) {
            content += questionContent + '\n\n';
        }

        // 回答内容
        const answerContent = document.querySelector('.RichText.ztext')?.textContent || 
                            document.querySelector('.Post-RichText')?.textContent || '';
        if (answerContent) {
            content += answerContent;
        }

        // 获取图片
        const images = [];
        const imgElements = document.querySelectorAll('.RichText.ztext img, .Post-RichText img');
        imgElements.forEach(img => {
            if (img.src && !img.src.includes('data:image')) {
                images.push({
                    url: img.src,
                    width: img.naturalWidth || 0,
                    height: img.naturalHeight || 0
                });
            }
        });

        // 获取点赞数
        const likeCount = document.querySelector('.VoteButton--up')?.textContent || 
                         document.querySelector('.Button.VoteButton.VoteButton--up')?.textContent || 
                         '0';

        // 获取评论数
        const commentCount = document.querySelector('.Comments-count')?.textContent || 
                           document.querySelector('.Button.ContentItem-action.Button--plain.Button--withIcon.Button--withLabel')?.textContent || 
                           '0';

        return {
            title: title.trim(),
            content: content.trim(),
            url: window.location.href,
            metadata: {
                author: author.trim(),
                platform: '知乎',
                paragraphCount: content.split('\n\n').length,
                images: images,
                likes: likeCount.trim(),
                comments: commentCount.trim(),
                timestamp: new Date().toISOString()
            }
        };
    } catch (error) {
        console.error('提取知乎内容时出错:', error);
        throw new Error('提取知乎内容失败: ' + error.message);
    }
}

// 判断是否为B视频页面
function isBilibiliVideoPage() {
    const hostname = window.location.hostname;
    const pathname = window.location.pathname;
    
    // 检查是否是B站视频页面
    if (hostname.includes('bilibili.com')) {
        // 视频播放页
        if (pathname.startsWith('/video/')) {
            return true;
        }
        
        // 番剧/电影/纪录片等播放页
        if (pathname.startsWith('/bangumi/play/')) {
            return true;
        }
        
        // 直播间
        if (pathname.startsWith('/live/')) {
            return true;
        }
    }
    
    return false;
}

// 修改 extractXiaohongshuContent 函数，复用 extractSocialMetadata 的逻辑
async function extractXiaohongshuContent() {
    try {
        console.log('检测到小红书文章，使用专用提取方法');

        // 等待内容加载完成
        await new Promise(resolve => setTimeout(resolve, 1000));

        // 获取标题选择器
        const titleSelectors = [
            'div[class*="title"]',
            'h1[class*="title"]',
            '.note-content .title',
            '.content .title'
        ];

        let title = '';
        for (const selector of titleSelectors) {
            const element = document.querySelector(selector);
            if (element && element.textContent.trim()) {
                title = element.textContent.trim();
                break;
            }
        }

        // 如果没有找到标题，使用文档标题
        if (!title) {
            title = document.title.replace(' - 小红书 - 你的生活指南', '').trim();
        }

        // 获取社交元数据
        const socialMetadata = extractSocialMetadata();
        console.log('从extractSocialMetadata获取的数据:', socialMetadata);

        // 确保所有必要的字段都存在
        const result = {
            title: title || socialMetadata.rawContent?.split('\n')[0] || '小红书笔记',
            url: window.location.href,
            content: socialMetadata.rawContent || '',
            metadata: {
                ...socialMetadata,
                platform: '小红书',
                source: 'xiaohongshu.com',
                extractionTime: new Date().toISOString(),
                // 确保这些字段一定存在
                author: socialMetadata.author || '未知作者',
                likes: socialMetadata.likes || '0',
                comments: socialMetadata.comments || '0',
                collects: socialMetadata.collects || '0',
                tags: socialMetadata.tags || [],
                images: socialMetadata.images || []
            }
        };

        // 验证数据完整性
        console.log('最终提取结果:', {
            title: result.title,
            contentLength: result.content.length,
            metadata: {
                author: result.metadata.author,
                likes: result.metadata.likes,
                comments: result.metadata.comments,
                collects: result.metadata.collects,
                tagsCount: result.metadata.tags.length,
                imagesCount: result.metadata.images.length
            }
        });

        return result;

    } catch (error) {
        console.error('提取小红书内容失败:', error);
        throw error;
    }
}

// 添加掘金内容提取函数
async function extractJuejinContent() {
    try {
        console.log('检到掘金页面，使用专用提取方法');
        
        // 检查页面是否加载完成
        if (!document.querySelector('.article')) {
            return {
                success: false,
                error: '页面未完全加载',
                received: true
            };
        }

        // 提标题
        const title = document.querySelector('.article-title')?.innerText.trim() || '';
        if (!title) {
            return {
                success: false,
                error: '未找到标题',
                received: true
            };
        }

        // 提取作者
        const author = document.querySelector('.author-info-box .author-name')?.innerText.trim() || '未知作者';

        // 提取发布时间
        const time = document.querySelector('.meta-box time')?.innerText.trim() || '';

        // 提取阅读量
        const views = document.querySelector('.views-count')?.innerText.trim() || '0';

        // 提取正文内容
        const content = document.querySelector('.article-content')?.innerText.trim() || 
                       document.querySelector('.markdown-body')?.innerText.trim() || '';

        if (!content) {
            return {
                success: false,
                error: '未找到内容',
                received: true
            };
        }

        // 提取标签
        const tags = Array.from(document.querySelectorAll('.tag-list .tag'))
            .map(tag => tag.innerText.trim())
            .filter(Boolean);

        // 提取图片
        const images = Array.from(document.querySelectorAll('.article img'))
            .map(img => img.src)
            .filter(src => src); // 过滤空值

        // 构造返回数据
        const extractedData = {
            title: cleanContent(title),
            url: window.location.href,
            content: cleanContent(content),
            metadata: {
                author: cleanContent(author),
                platform: '掘金',
                source: 'juejin.cn',
                publishTime: time,
                views: views,
                tags: tags,
                paragraphCount: content.split('\n\n').length,
                images: images,
                timestamp: new Date().toISOString()
            }
        };

        console.log('提取的掘金内容:', extractedData);
        
        return {
            success: true,
            data: extractedData,
            type: 'juejin',
            received: true
        };
        
    } catch(error) {
        console.error('提取掘金内容时出错:', error);
        return {
            success: false,
            error: error.message,
            received: true
        };
    }
}

// 添加微信公众号文章内容提取函数
function extractWechatContent() {
    console.log('检测到微信公众号文章，使用专用提取方法');
    
    try {
        // 获取标题 - 增加更多选择器
        const titleSelectors = [
            '#activity-name',
            'h1',
            '#js_article h1',
            '.rich_media_title',
            '#js_msg_title'
        ];
        
        let title = null;
        for (const selector of titleSelectors) {
            const element = document.querySelector(selector);
            if (element && element.textContent.trim()) {
                title = element.textContent.trim();
                break;
            }
        }
        
        if (!title) {
            console.error('未找到文章标题');
            throw new Error('未找到文章标题');
        }
        
        // 获取作者（公众号名称）
        const authorSelectors = [
            '#js_name',
            '#profileBt .profile_nickname',
            '#js_profile_qrcode > div > strong',
            '.account_nickname_inner'
        ];
        
        let author = null;
        for (const selector of authorSelectors) {
            const element = document.querySelector(selector);
            if (element && element.textContent.trim()) {
                author = element.textContent.trim();
                break;
            }
        }
        
        // 获取发布时间
        const dateSelectors = [
            '#publish_time',
            '.article-meta__time',
            '#js_publish_time',
            '.publish_time'
        ];
        
        let publishDate = null;
        for (const selector of dateSelectors) {
            const element = document.querySelector(selector);
            if (element && element.textContent.trim()) {
                publishDate = element.textContent.trim();
                break;
            }
        }
        
        // 获取正文内容
        let paragraphs = [];
        
        // 主要内容区域选择器
        const contentSelectors = [
            '#js_content',
            '.rich_media_content',
            '.rich_media_area_primary'
        ];
        
        let contentArea = null;
        for (const selector of contentSelectors) {
            const element = document.querySelector(selector);
            if (element) {
                contentArea = element;
                break;
            }
        }
        
        if (!contentArea) {
            console.error('未找到文章内容区域');
            throw new Error('未找到文章内容区域');
        }
        
        // 获取所有文本段落
        const elements = contentArea.querySelectorAll('p, section, h2, h3, h4, blockquote');
        elements.forEach(element => {
            // 取元素的实际文本内容
            let text = '';
            
            // 处理特殊情况：元素内部可能包含其他元素
            if (element.childNodes.length > 0) {
                // 遍历所有子节点
                element.childNodes.forEach(node => {
                    // 果是文本节点，直接添加文本
                    if (node.nodeType === Node.TEXT_NODE) {
                        text += node.textContent.trim() + ' ';
                    }
                    // 如果是元素节点，且不是图片或视频，添加其文本内容
                    else if (node.nodeType === Node.ELEMENT_NODE && 
                            !['IMG', 'VIDEO', 'IFRAME'].includes(node.tagName)) {
                        text += node.textContent.trim() + ' ';
                    }
                });
            } else {
                text = element.textContent.trim();
            }
            
            text = text.trim();
            
            // 过滤无效内容
            if (text && 
                text.length > 5 && 
                !text.includes('微信扫一扫') &&
                !text.includes('长按识别二维码') &&
                !text.includes('预览时标签不可点') &&
                !text.includes('继续滑动看下一个') &&
                !text.includes('分享') &&
                !text.includes('复制链接') &&
                !text.includes('喜欢此内容的人还喜欢') &&
                !text.includes('相关推荐')) {
                paragraphs.push(text);
            }
        });
        
        if (paragraphs.length === 0) {
            console.error('未找到有效的文章内容');
            throw new Error('未找到有效的文章内容');
        }
        
        // 获取文章图片
        const images = Array.from(contentArea.querySelectorAll('img'))
            .map(img => img.src || img.dataset.src)
            .filter(src => src && !src.includes('data:image'));
        
        const result = {
            title,
            url: window.location.href,
            content: paragraphs.join('\n\n'),
            metadata: {
                author,
                publishDate,
                platform: '微信公众号',
                paragraphCount: paragraphs.length,
                images: images,
                timestamp: new Date().toISOString()
            }
        };
        
        console.log('成功提取微信公众号文章:', {
            titleLength: result.title.length,
            contentLength: result.content.length,
            paragraphs: result.metadata.paragraphCount,
            images: result.metadata.images.length
        });
        
        return result;
        
    } catch (error) {
        console.error('提取微信公众号内容时出错:', error);
        throw error;
    }
}

function extractBilibiliContent() {
    console.log('开始提取B站视频内容');
    
    try {
        // 获视频标题
        const titleElement = document.querySelector('h1.video-title');
        if (!titleElement) {
            throw new Error('未找到视频标题');
        }
        const title = titleElement.textContent.trim();
        
        // 获取视频描述
        const descElement = document.querySelector('.video-desc-container .desc-info-text');
        const description = descElement ? descElement.textContent.trim() : '';
        
        // 获取作者信息
        const authorElement = document.querySelector('.up-name');
        const author = authorElement ? authorElement.textContent.trim() : '';
        
        // 获取发布时间
        const timeElement = document.querySelector('.video-publish time');
        const publishTime = timeElement ? timeElement.textContent.trim() : '';
        
        // 获取视频封面
        const coverElement = document.querySelector('meta[property="og:image"]');
        const cover = coverElement ? coverElement.getAttribute('content') : '';
        
        // 获取视频统计信息
        const viewCountElement = document.querySelector('.view.item');
        const viewCount = viewCountElement ? viewCountElement.textContent.trim() : '';
        
        const likeElement = document.querySelector('.like.item');
        const likeCount = likeElement ? likeElement.textContent.trim() : '';
        
        // 构建内容
        let content = `标题：${title}\n\n`;
        if (description) {
            content += `介绍：${description}\n\n`;
        }
        content += `作者：${author}\n`;
        if (publishTime) {
            content += `发布时间：${publishTime}\n`;
        }
        if (viewCount) {
            content += `播放量：${viewCount}\n`;
        }
        if (likeCount) {
            content += `点赞数：${likeCount}\n`;
        }
        
        return {
            title: title,
            url: window.location.href,
            content: content,
            metadata: {
                platform: 'Bilibili',
                author: author,
                publishTime: publishTime,
                description: description,
                cover: cover,
                stats: {
                    views: viewCount,
                    likes: likeCount
                }
            }
        };
    } catch (error) {
        console.error('提取B站视频内容失败:', error);
        throw error;
    }
}

async function extractCSDNContent() {
    try {
        console.log('检测到CSDN页面，使用专用提取方法');
        
        // 检查页面是否加载完成
        if (!document.querySelector('.blog-content-box')) {
            return {
                success: false,
                error: '页面未完全加载',
                received: true
            };
        }

        // 提取标题
        const title = document.querySelector('.title-article')?.innerText.trim() || '';
        if (!title) {
            return {
                success: false,
                error: '未找到标题',
                received: true
            };
        }

        // 提取作者
        const author = document.querySelector('.follow-nickName')?.innerText.trim() || '未知作者';

        // 提取发布时间
        const timeElement = document.querySelector('.article-info-box .time');
        const time = timeElement ? timeElement.innerText.replace(/于|发布/g, '').trim() : '';

        // 提取阅读量
        const views = document.querySelector('.read-count')?.innerText.replace(/阅读量/g, '').trim() || '0';

        // 提取点赞数
        const likes = document.querySelector('#blog-digg-num')?.innerText.replace(/点赞数/g, '').trim() || '0';

        // 提取正文内容
        const content = document.querySelector('#content_views')?.innerText.trim() || '';
        if (!content) {
            return {
                success: false,
                error: '未找到内容',
                received: true
            };
        }

        // 提取标签
        const tags = Array.from(document.querySelectorAll('.artic-tag-box .tag-link'))
            .map(tag => tag.innerText.trim())
            .filter(tag => tag);

        // 提取图片
        const images = Array.from(document.querySelectorAll('#content_views img'))
            .map(img => img.src)
            .filter(src => src && !src.includes('mathcode')); // 过滤掉数学公式图片

        // 构造返回数据
        const extractedData = {
            title: cleanContent(title),
            url: window.location.href,
            content: cleanContent(content),
            metadata: {
                author: cleanContent(author),
                platform: 'CSDN',
                source: 'csdn.net',
                publishTime: time,
                views: views,
                likes: likes,
                tags: tags,
                paragraphCount: content.split('\n\n').length,
                images: images,
                timestamp: new Date().toISOString()
            }
        };

        console.log('提取的CSDN内容:', extractedData);
        
        return {
            success: true,
            data: extractedData,
            type: 'csdn',
            received: true
        };
        
    } catch(error) {
        console.error('提取CSDN内容出错:', error);
        return {
            success: false,
            error: error.message,
            received: true
        };
    }
}

// 提取快手内容
function extractKuaishouContent() {
    console.log('检测到快手内容，使用专用提取方法');
    
    try {
        // 获取标题/描述内容
        const titleElement = document.querySelector('.video-info-title');
        let title = '';
        let content = '';
        
        if (titleElement) {
            // 获取原始文本内容，包括标签
            content = titleElement.innerHTML.trim();
            
            // 获取纯文本作为标题（移除HTML标签）
            title = titleElement.textContent.trim();
        }
        
        // 获取作者信息
        const authorElement = document.querySelector('.profile-user-name-title');
        const author = authorElement ? authorElement.textContent.trim() : '';
        
        // 获取发布时间
        const timeElement = document.querySelector('.video-info-time');
        const publishTime = timeElement ? timeElement.textContent.trim() : '';
        
        // 获取点赞数
        const likeElement = document.querySelector('.like-cnt');
        const likes = likeElement ? likeElement.textContent.trim() : '';
        
        // 获取评论数
        const commentElement = document.querySelector('.comment-cnt');
        const comments = commentElement ? commentElement.textContent.trim() : '';
        
        // 获取分享数
        const shareElement = document.querySelector('.share-cnt');
        const shares = shareElement ? shareElement.textContent.trim() : '';
        
        // 获取标签
        const hashtags = [];
        const hashtagElements = document.querySelectorAll('.video-info-title a[href*="hashtag"]');
        hashtagElements.forEach(tag => {
            const tagText = tag.textContent.trim();
            if (tagText.startsWith('#')) {
                hashtags.push(tagText);
            } else {
                hashtags.push(`#${tagText}`);
            }
        });
        
        // 构造返回对象
        const result = {
            title: title || '快手视频',
            url: window.location.href,
            content: title,
            metadata: {
                platform: '快手',
                author: author,
                publishTime: publishTime,
                stats: {
                    likes: likes,
                    comments: comments,
                    shares: shares
                },
                hashtags: hashtags,
                timestamp: new Date().toISOString()
            }
        };
        
        console.log('提取的快手内容:', result);
        return result;
        
    } catch (error) {
        console.error('提取快手内容失败:', error);
        throw error;
    }
}

// 提取百度文章内容
async function extractBaiduContent() {
    console.log('检测到百度文章页面，使用专用提取方法');
    
    try {
        // 获取标题
        const titleElement = document.querySelector('.sKHSJ');
        const title = titleElement ? titleElement.textContent.trim() : document.title;
        
        // 获取作者信息
        const authorElement = document.querySelector('[data-testid="author-name"]');
        const author = authorElement ? authorElement.textContent.trim() : '未知作者';
        
        // 获取发布时间
        const timeElement = document.querySelector('[data-testid="updatetime"]');
        const publishTime = timeElement ? timeElement.textContent.trim() : '';
        
        // 获取地区
        const addressElement = document.querySelector('[data-testid="address"]');
        const address = addressElement ? addressElement.textContent.trim() : '';
        
        // 获取摘要
        const summaryElement = document.querySelector('._3mz_a');
        const summary = summaryElement ? summaryElement.textContent.trim() : '';
        
        // 获取正文内容
        const contentElements = document.querySelectorAll('._18p7x p, ._18p7x .dpu8C');
        const contentArray = Array.from(contentElements).map(el => el.textContent.trim());
        const content = contentArray.filter(text => text.length > 0).join('\n\n');
        
        // 获取图片
        const images = Array.from(document.querySelectorAll('._18p7x img')).map(img => ({
            url: img.src,
            alt: img.alt || ''
        }));
        
        // 构造返回对象
        const result = {
            title: title,
            url: window.location.href,
            content: content,
            metadata: {
                platform: '百度文章',
                author: author,
                publishTime: publishTime,
                address: address,
                summary: summary,
                images: images,
                timestamp: new Date().toISOString()
            }
        };
        
        console.log('提取的百度文章内容:', result);
        return result;
        
    } catch (error) {
        console.error('提取百度文章内容失败:', error);
        throw error;
    }
}

// 添加固定采集按钮
function addCollectButton() {
    // 检查是否已存在按钮
    if (document.getElementById('xhs-collect-btn')) {
        return;
    }

    // 创建按钮容器
    const buttonContainer = document.createElement('div');
    buttonContainer.id = 'xhs-collect-btn';
    buttonContainer.style.cssText = `
        position: fixed;
        top: 20px;
        left: 20px;
        z-index: 9999;
        display: flex;
        align-items: center;
        gap: 8px;
    `;

    // 创建采集按钮
    const collectButton = document.createElement('button');
    collectButton.innerHTML = '采集';
    collectButton.style.cssText = `
        background: #ff2442;
        color: white;
        border: none;
        border-radius: 4px;
        padding: 8px 16px;
        font-size: 14px;
        cursor: pointer;
        display: flex;
        align-items: center;
        gap: 4px;
        box-shadow: 0 2px 8px rgba(0,0,0,0.1);
        transition: all 0.3s ease;
    `;

    // 添加悬停效果
    collectButton.onmouseover = () => {
        collectButton.style.transform = 'translateY(-2px)';
        collectButton.style.boxShadow = '0 4px 12px rgba(0,0,0,0.15)';
    };
    collectButton.onmouseout = () => {
        collectButton.style.transform = 'translateY(0)';
        collectButton.style.boxShadow = '0 2px 8px rgba(0,0,0,0.1)';
    };

    // 修改采集按钮的点击事件处理
    collectButton.onclick = async () => {
        try {
            // 显示加载中状态
            collectButton.disabled = true;
            collectButton.innerHTML = '采集中...';
            
            // 等待页面完全加载
            if (document.readyState !== 'complete') {
                await new Promise(resolve => {
                    window.addEventListener('load', resolve, { once: true });
                });
            }
            
            // 额外等待一段时间确保动态内容加载完成
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            // 使用 ExtractManager 处理采集请求
            const response = await ExtractManager.handleExtractRequest({
                action: 'collect',
                idea: ''
            }, (response) => {
                console.log('采集响应:', response);
            });

            if (response && response.success) {
                showNotification('开始处理...', 'info');
            } else {
                showNotification(response?.message || '采集失败', 'error');
            }
        } catch (error) {
            console.error('采集失败:', error);
            showNotification('采集失败: ' + error.message, 'error');
        } finally {
            // 恢复按钮状态
            collectButton.disabled = false;
            collectButton.innerHTML = '采集';
        }
    };

    // 添加到页面
    buttonContainer.appendChild(collectButton);
    document.body.appendChild(buttonContainer);
}

// 在页面加载完成后添加按钮，并确保在URL变化时重新添加
if (window.location.hostname.includes('xiaohongshu.com')) {
    // 初始添加按钮
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', addCollectButton);
    } else {
        addCollectButton();
    }

    // 监听URL变化
    let lastUrl = window.location.href;
    new MutationObserver(() => {
        const currentUrl = window.location.href;
        if (currentUrl !== lastUrl) {
            lastUrl = currentUrl;
            setTimeout(addCollectButton, 1000); // 等待新页面内容加载
        }
    }).observe(document.body, { subtree: true, childList: true });
}

// 添加提取器管理器
const ExtractorManager = {
    extractors: {
        'mp.weixin.qq.com': {
            name: '微信公众号',
            extract: extractWechatContent
        },
        'web.okjike.com': {
            name: '即刻',
            extract: extractJikeContent
        },
        'deepseek.com': {
            name: 'DeepSeek',
            extract: extractDeepSeekContent
        },
        'chat.deepseek.com': {
            name: 'DeepSeek Chat',
            extract: extractDeepSeekContent
        },
        'weibo.com': {
            name: '微博',
            extract: extractWeiboContent
        },
        'zsxq.com': {
            name: '知识星球',
            extract: extractZsxqContent
        }
    },

    getExtractor(hostname) {
        return this.extractors[hostname];
    },

    async extract(hostname) {
        const extractor = this.getExtractor(hostname);
        if (extractor) {
            console.log(`使用 ${extractor.name} 专用提取方法`);
            return await extractor.extract();
        }
        console.log('使用通用提取方法');
        return await extractGeneralContent();
    }
};

// 添加DeepSeek内容提取函数
async function extractDeepSeekContent() {
    try {
        console.log('检测到DeepSeek页面，使用专用提取方法');
        
        // 获取标题 - 使用提供的选择器
        const titleElement = document.querySelector('div.d8ed659a[tabindex="0"]');
        const title = titleElement?.textContent?.trim() || document.title;
        
        console.log('提取到DeepSeek标题:', title);

        // 获取对话内容
        let content = '';
        
        // 获取所有用户提问和AI回答(div.f9bf7997)，忽略无需采集的内容(div.cbcaa82c)
        const messages = document.querySelectorAll('div.f9bf7997, div.fbb737a4');
        const messageContents = Array.from(messages).map(msg => {
            const textContent = msg.textContent.trim();
            // 这里不再添加"DeepSeek:"前缀，保留原始内容
            return textContent || '';
        }).filter(Boolean);
        
        // 如果有消息内容，直接使用
        if (messageContents.length > 0) {
            content = messageContents.join('\n\n');
        } else {
            // 如果没有找到消息内容，尝试使用其他选择器
            // 尝试获取整个聊天容器，但排除 div.cbcaa82c 元素
            const chatContainer = document.querySelector('div.a5cd95be') || 
                                 document.querySelector('div.be88ba8a');
            
            if (chatContainer) {
                // 创建一个副本用于处理
                const containerClone = chatContainer.cloneNode(true);
                
                // 移除所有 div.cbcaa82c 元素（无需采集的内容）
                const excludeDivs = containerClone.querySelectorAll('div.cbcaa82c');
                excludeDivs.forEach(div => div.remove());
                
                // 获取所有段落
                const paragraphs = Array.from(containerClone.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, pre, code'))
                    .map(p => p.textContent.trim())
                    .filter(text => text.length > 0);
                
                content = paragraphs.join('\n\n');
            }
        }
        
        // 如果仍然没有内容，尝试获取页面上的所有文本，但排除 div.cbcaa82c 元素
        if (!content) {
            // 创建一个副本用于处理
            const bodyClone = document.body.cloneNode(true);
            
            // 移除所有 div.cbcaa82c 元素（无需采集的内容）
            const excludeDivs = bodyClone.querySelectorAll('div.cbcaa82c');
            excludeDivs.forEach(div => div.remove());
            
            const bodyText = bodyClone.textContent.trim();
            if (bodyText) {
                // 清理文本，移除过多的空白
                content = bodyText.replace(/\s+/g, ' ').trim();
            }
        }

        console.log('提取到DeepSeek内容长度:', content.length);

        return {
            title,
            url: window.location.href,
            content,
            metadata: {
                author: 'DeepSeek AI', // DeepSeek 的作者信息
                platform: 'DeepSeek',
                publishTime: new Date().toISOString(), // 使用当前时间
                tags: ['AI', '聊天', 'DeepSeek'], // 添加默认标签
                images: [], // DeepSeek 聊天页面通常没有图片
                paragraphCount: content.split('\n\n').length,
                timestamp: new Date().toISOString(),
                chatType: 'deepseek'
            }
        };

    } catch (error) {
        console.error('提取DeepSeek内容时出错:', error);
        throw new Error('提取DeepSeek内容失败: ' + error.message);
    }
}

// 添加微博内容提取函数
async function extractWeiboContent() {
    try {
        console.log('检测到微博页面，使用专用提取方法');

        // 获取作者信息
        const author = document.querySelector('.username')?.textContent?.trim() || 
                      document.querySelector('.woo-font--extraLight')?.textContent?.trim() ||
                      '未知作者';

        // 获取发布时间
        const publishTime = document.querySelector('.time')?.textContent?.trim() || 
                          document.querySelector('.woo-box-flex .woo-box-alignCenter')?.textContent?.trim() ||
                          '';

        // 获取微博正文
        const contentElement = document.querySelector('.detail_wbtext_4CRf9') || 
                             document.querySelector('.content');
        
        // 处理内容，包括提取超链接
        let content = '';
        let processedContent = '';
        
        if (contentElement) {
            // 获取原始文本内容
            content = contentElement.textContent.trim();
            
            // 创建一个副本用于处理
            const contentClone = contentElement.cloneNode(true);
            
            // 处理所有超链接，将链接URL添加到文本中
            const links = contentClone.querySelectorAll('a');
            links.forEach(link => {
                // 检查是否是有效链接
                if (link.href && link.href.startsWith('http')) {
                    // 如果链接文本不包含完整URL，则添加URL
                    if (!link.textContent.includes(link.href)) {
                        // 创建一个新的文本节点，包含链接URL
                        const linkText = document.createTextNode(` [${link.href}] `);
                        
                        // 在链接元素后插入链接URL
                        if (link.nextSibling) {
                            link.parentNode.insertBefore(linkText, link.nextSibling);
                        } else {
                            link.parentNode.appendChild(linkText);
                        }
                    }
                }
            });
            
            // 获取处理后的文本内容
            processedContent = contentClone.textContent.trim();
        }

        // 检查是否有转发内容
        const retweetElement = document.querySelector('.retweet.Feed_retweet_JqZJb') || 
                              document.querySelector('.Feed_retweet_JqZJb') ||
                              document.querySelector('[class*="retweet"]');
        
        let retweetData = null;
        
        if (retweetElement) {
            console.log('检测到转发内容，提取转发信息');
            
            // 获取转发作者
            const retweetAuthor = retweetElement.querySelector('.detail_nick_u-ffy')?.textContent?.trim() ||
                                 retweetElement.querySelector('a[usercard]')?.textContent?.trim() ||
                                 '未知作者';
            
            // 获取转发内容
            const retweetContentElement = retweetElement.querySelector('.detail_wbtext_4CRf9') || 
                                         retweetElement.querySelector('[class*="detail_reText"]');
            
            let retweetContent = '';
            let processedRetweetContent = '';
            
            if (retweetContentElement) {
                // 获取原始文本内容
                retweetContent = retweetContentElement.textContent.trim();
                
                // 创建一个副本用于处理
                const retweetContentClone = retweetContentElement.cloneNode(true);
                
                // 处理所有超链接，将链接URL添加到文本中
                const retweetLinks = retweetContentClone.querySelectorAll('a');
                retweetLinks.forEach(link => {
                    // 检查是否是有效链接
                    if (link.href && link.href.startsWith('http')) {
                        // 排除@用户链接
                        if (!link.href.includes('/u/') && !link.href.includes('/n/')) {
                            // 如果链接文本不包含完整URL，则添加URL
                            if (!link.textContent.includes(link.href)) {
                                // 创建一个新的文本节点，包含链接URL
                                const linkText = document.createTextNode(` [${link.href}] `);
                                
                                // 在链接元素后插入链接URL
                                if (link.nextSibling) {
                                    link.parentNode.insertBefore(linkText, link.nextSibling);
                                } else {
                                    link.parentNode.appendChild(linkText);
                                }
                            }
                        }
                    }
                });
                
                // 获取处理后的文本内容
                processedRetweetContent = retweetContentClone.textContent.trim();
            }
            
            // 获取转发时间
            const retweetTime = retweetElement.querySelector('.head-info_time_6sFQg')?.textContent?.trim() || '';
            
            // 获取转发微博的URL
            const retweetUrl = retweetElement.querySelector('.head-info_time_6sFQg')?.href || '';
            
            // 获取转发微博的互动数据
            const retweetLikes = retweetElement.querySelector('.woo-like-count')?.textContent?.trim() || '0';
            const retweetComments = retweetElement.querySelector('[title="评论"] + .toolbar_num_JXZul')?.textContent?.trim() || '0';
            const retweetReposts = retweetElement.querySelector('[title="转发"] + .toolbar_num_JXZul')?.textContent?.trim() || '0';
            
            // 获取转发微博的图片
            const retweetImages = Array.from(retweetElement.querySelectorAll('.woo-picture-img'))
                .map(img => ({
                    url: img.src,
                    alt: img.alt || ''
                }))
                .filter(img => img.url && !img.url.includes('data:image'));
            
            // 构造转发数据
            retweetData = {
                author: retweetAuthor,
                content: cleanContent(processedRetweetContent || retweetContent),
                url: retweetUrl,
                publishTime: retweetTime,
                images: retweetImages,
                interactions: {
                    likes: retweetLikes,
                    comments: retweetComments,
                    reposts: retweetReposts
                }
            };
            
            // 如果原微博没有内容，但有转发内容，则使用转发内容作为主要内容
            if (!content && retweetContent) {
                content = `转发 @${retweetAuthor}：${retweetContent}`;
                processedContent = `转发 @${retweetAuthor}：${processedRetweetContent}`;
            }
        }

        // 获取互动数据
        const likes = document.querySelector('[data-testid="like"] .woo-like-count')?.textContent || '0';
        const reposts = document.querySelector('[data-testid="forward"] .woo-like-count')?.textContent || '0';
        const comments = document.querySelector('[data-testid="comment"] .woo-like-count')?.textContent || '0';

        // 获取图片
        const images = Array.from(document.querySelectorAll('.woo-picture-img, .media-piclist img'))
            .map(img => ({
                url: img.src,
                alt: img.alt || ''
            }))
            .filter(img => img.url && !img.url.includes('data:image'));

        // 获取话题标签
        const topics = Array.from(document.querySelectorAll('.topic-link, .woo-box-item-flex a[href*="topic"]'))
            .map(topic => topic.textContent.trim())
            .filter(Boolean);
            
        // 获取所有外部链接
        const externalLinks = [];
        
        // 从正文中提取链接
        if (contentElement) {
            const linkElements = contentElement.querySelectorAll('a');
            linkElements.forEach(link => {
                if (link.href && link.href.startsWith('http')) {
                    // 排除话题链接和@用户链接
                    if (!link.href.includes('/topic/') && !link.href.includes('/n/')) {
                        externalLinks.push({
                            text: link.textContent.trim(),
                            url: link.href
                        });
                    }
                }
            });
        }
        
        // 特别处理视频链接
        const videoLinks = document.querySelectorAll('a[href*="video.weibo.com/show"]');
        videoLinks.forEach(link => {
            if (link.href && !externalLinks.some(item => item.url === link.href)) {
                externalLinks.push({
                    text: link.textContent.trim() || '微博视频',
                    url: link.href,
                    type: 'video'
                });
            }
        });

        // 构造返回数据
        const result = {
            title: content.split('\n')[0] || '微博内容', // 使用第一行作为标题
            url: window.location.href,
            content: cleanContent(processedContent || content), // 使用处理后的内容
            metadata: {
                author,
                platform: '微博',
                publishTime,
                topics,
                images,
                externalLinks, // 添加外部链接数据
                interactions: {
                    likes,
                    reposts,
                    comments
                },
                paragraphCount: content.split('\n\n').length,
                timestamp: new Date().toISOString()
            }
        };
        
        // 如果有转发内容，添加到元数据中
        if (retweetData) {
            result.metadata.retweet = retweetData;
        }
        
        return result;

    } catch (error) {
        console.error('提取微博内容时出错:', error);
        throw new Error('提取微博内容失败: ' + error.message);
    }
}

// 添加知识星球内容提取函数
async function extractZsxqContent() {
    try {
        console.log('检测到知识星球页面，使用专用提取方法');

        // 等待内容加载
        await new Promise(resolve => setTimeout(resolve, 1000));

        // 首先定位到主要内容面板
        const topicDetailPanel = document.querySelector('.topic-detail-panel');
        
        if (!topicDetailPanel) {
            throw new Error('未找到知识星球内容面板，请确保您在帖子详情页面');
        }
        
        console.log('成功找到知识星球内容面板');

        // 获取星球名称 - 仅从内容面板中查找
        const groupName = topicDetailPanel.querySelector('.enter-group .left')?.textContent?.trim().replace('来自：', '') || '未知星球';

        // 获取作者信息 - 仅从内容面板中查找
        const author = topicDetailPanel.querySelector('.role.member')?.textContent?.trim() || 
                      topicDetailPanel.querySelector('.author .info div:first-child')?.textContent?.trim() || 
                      '未知作者';

        // 获取发布时间 - 仅从内容面板中查找
        const publishTime = topicDetailPanel.querySelector('.author .date')?.textContent?.trim() || '';

        // 获取正文内容 - 仅从内容面板中查找
        const contentDiv = topicDetailPanel.querySelector('.talk-content-container .content');
        
        // 处理内容，包括提取超链接
        let title = '';
        let content = '';
        let processedContent = '';
        
        if (contentDiv) {
            // 尝试获取标题（通常是第一个strong元素或第一行文本）
            const titleElement = contentDiv.querySelector('strong');
            if (titleElement) {
                title = titleElement.textContent.trim();
            } else {
                // 如果没有strong标签，使用第一行文本作为标题
                const firstLine = contentDiv.textContent.trim().split('\n')[0];
                title = firstLine || '知识星球内容';
            }
            
            // 获取原始文本内容
            content = contentDiv.textContent.trim();
            
            // 创建一个副本用于处理
            const contentClone = contentDiv.cloneNode(true);
            
            // 处理所有超链接，将链接URL添加到文本中
            const links = contentClone.querySelectorAll('a');
            links.forEach(link => {
                // 检查是否是有效链接
                if (link.href && link.href.startsWith('http')) {
                    // 如果链接文本不包含完整URL，则添加URL
                    if (!link.textContent.includes(link.href)) {
                        // 创建一个新的文本节点，包含链接URL
                        const linkText = document.createTextNode(` [${link.href}] `);
                        
                        // 在链接元素后插入链接URL
                        if (link.nextSibling) {
                            link.parentNode.insertBefore(linkText, link.nextSibling);
                        } else {
                            link.parentNode.appendChild(linkText);
                        }
                    }
                }
            });
            
            // 获取处理后的文本内容
            processedContent = contentClone.textContent.trim();
        } else {
            console.warn('未找到内容元素');
        }

        // 获取标签 - 仅从内容面板中查找
        const tags = Array.from(topicDetailPanel.querySelectorAll('.tag-container .tag'))
            .map(tag => tag.textContent.trim())
            .filter(Boolean);

        // 获取点赞数 - 仅从内容面板中查找
        const likeText = topicDetailPanel.querySelector('.like-text')?.textContent || '';
        const likeCount = likeText.match(/\d+/) ? likeText.match(/\d+/)[0] : '0';

        // 获取评论 - 仅从内容面板中查找
        const comments = [];
        const commentItems = topicDetailPanel.querySelectorAll('.comment-container .comment-item');
        commentItems.forEach(item => {
            const commentAuthor = item.querySelector('.comment')?.textContent || '';
            const commentText = item.querySelector('.text:last-child')?.textContent || '';
            const commentTime = item.querySelector('.time')?.textContent || '';
            
            if (commentText && commentAuthor) {
                comments.push({
                    author: commentAuthor,
                    text: commentText,
                    time: commentTime
                });
            }
        });

        // 获取图片 - 仅从内容面板中查找
        const images = [];
        const imgElements = topicDetailPanel.querySelectorAll('.talk-content-container img');
        imgElements.forEach(img => {
            if (img.src && !img.src.includes('data:image') && !img.src.includes('avatar')) {
                images.push({
                    url: img.src,
                    width: img.naturalWidth || 0,
                    height: img.naturalHeight || 0,
                    alt: img.alt || ''
                });
            }
        });
        
        // 获取所有外部链接 - 仅从内容面板中查找
        const externalLinks = [];
        const linkElements = contentDiv?.querySelectorAll('a[target="_blank"]') || [];
        linkElements.forEach(link => {
            if (link.href && link.href.startsWith('http')) {
                externalLinks.push({
                    text: link.textContent.trim(),
                    url: link.href
                });
            }
        });

        // 构造返回数据
        const extractedData = {
            title: title || '知识星球内容',
            url: window.location.href,
            content: cleanContent(processedContent || content), // 使用处理后的内容
            metadata: {
                author: cleanContent(author),
                publishTime: cleanContent(publishTime),
                platform: '知识星球',
                groupName: groupName,
                tags: tags,
                source: 'zsxq.com',
                paragraphCount: content.split('\n\n').length,
                images: images,
                externalLinks: externalLinks, // 添加外部链接数据
                comments: comments,
                likes: likeCount,
                timestamp: new Date().toISOString()
            }
        };

        console.log('提取的知识星球内容:', extractedData);
        return extractedData;

    } catch (error) {
        console.error('提取知识星球内容时出错:', error);
        throw new Error('提取知识星球内容失败: ' + error.message);
    }
}
