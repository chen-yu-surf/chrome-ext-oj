/**
 * content.js - 内容脚本
 * 生效域名: http://jx.7fa4.cn:8888/problem/*
 * 负责：提取题目Markdown/HTML内容
 */

// 防止重复注入
if (!window.__AI_TUTOR_CONTENT_INJECTED__) {
  window.__AI_TUTOR_CONTENT_INJECTED__ = true;

  console.log('[content.js] 内容脚本已注入，当前URL:', window.location.href);

  // 监听来自background的消息
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log('[content.js] received message:', message);

    if (message.type === 'EXTRACT_PROBLEM') {
      extractProblemData()
        .then(data => {
          console.log('[content.js] extracted data:', data);
          sendResponse(data);
        })
        .catch(error => {
          console.error('[content.js] extraction error:', error);
          sendResponse({ error: error.message });
        });
      return true; // 保持异步sendResponse通道
    }
  });

  /**
   * 提取题目数据
   * 1. 获取页面标题
   * 2. 查找"题面源码"链接
   * 3. 获取Markdown源码内容
   */
  async function extractProblemData() {
    // 获取题目标题
    const titleEl = document.querySelector('h1.ui.header');
    const title = titleEl ? titleEl.textContent.trim() : '未知题目';
    console.log('[content.js] 题目标题:', title);

    // 获取题目ID（从URL提取）
    const urlMatch = window.location.pathname.match(/\/problem\/(\d+)/);
    const problemId = urlMatch ? urlMatch[1] : 'unknown';
    console.log('[content.js] 题目ID:', problemId);

    // 查找"题面源码"链接
    const links = document.querySelectorAll('a');
    let markdownUrl = null;
    for (const link of links) {
      if (link.textContent.trim() === '题面源码') {
        markdownUrl = link.href;
        break;
      }
    }
    console.log('[content.js] 题面源码链接:', markdownUrl);

    let markdownContent = '';

    if (markdownUrl) {
      try {
        // 请求题面源码页面获取Markdown内容
        const response = await fetch(markdownUrl);
        if (!response.ok) {
          throw new Error(`获取题面源码失败: HTTP ${response.status}`);
        }
        const html = await response.text();
        
        // 解析返回的HTML，提取Markdown源码
        markdownContent = extractMarkdownFromHTML(html);
        console.log('[content.js] Markdown内容长度:', markdownContent.length);
      } catch (e) {
        console.error('[content.js] 获取题面源码失败:', e);
        // 降级方案：从页面直接提取题目内容
        markdownContent = extractFromPage();
      }
    } else {
      // 没有找到题面源码链接，从页面直接提取
      console.log('[content.js] 未找到题面源码链接，使用页面提取');
      markdownContent = extractFromPage();
    }

    return {
      success: true,
      title: title,
      problemId: problemId,
      content: markdownContent,
      url: window.location.href
    };
  }

  /**
   * 从题面源码页面HTML中提取Markdown内容
   */
  function extractMarkdownFromHTML(html) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    
    // 尝试查找<pre>或<code>或<textarea>中的Markdown源码
    const preEl = doc.querySelector('pre');
    if (preEl) {
      return preEl.textContent.trim();
    }

    // 尝试取body中的纯文本（去除script和style）
    const scripts = doc.querySelectorAll('script, style, nav, header, footer');
    scripts.forEach(el => el.remove());

    // 查找主内容区域
    const mainContent = doc.querySelector('.ui.container') || 
                        doc.querySelector('.segment') ||
                        doc.querySelector('body');
    
    if (mainContent) {
      return mainContent.textContent.trim();
    }

    return doc.body ? doc.body.textContent.trim() : '';
  }

  /**
   * 从当前页面直接提取题目内容（降级方案）
   */
  function extractFromPage() {
    // 查找题目内容区域
    const contentEl = document.querySelector('.ui.bottom.attached.segment.font-content');
    if (!contentEl) {
      console.log('[content.js] 未找到题目内容区域');
      return '无法提取题目内容';
    }

    // 克隆节点并清理干扰元素
    const clone = contentEl.cloneNode(true);
    
    // 移除广告、不相关元素
    const removeSelectors = [
      '.ad', '.advertisement', '.banner',
      'script', 'style', 'iframe'
    ];
    removeSelectors.forEach(sel => {
      clone.querySelectorAll(sel).forEach(el => el.remove());
    });

    // 提取文本内容，保留结构
    return extractStructuredText(clone);
  }

  /**
   * 提取结构化文本
   */
  function extractStructuredText(element) {
    let result = '';
    const walker = document.createTreeWalker(
      element,
      NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
      null,
      false
    );

    let node;
    while (node = walker.nextNode()) {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent.trim();
        if (text) result += text + ' ';
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const tag = node.tagName.toLowerCase();
        if (['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(tag)) {
          result += '\n\n## ' + node.textContent.trim() + '\n\n';
          // 跳过该元素的子节点
          walker.nextSibling();
        } else if (tag === 'p') {
          result += '\n';
        } else if (tag === 'br') {
          result += '\n';
        } else if (tag === 'pre' || tag === 'code') {
          result += '\n```\n' + node.textContent + '\n```\n';
          walker.nextSibling();
        }
      }
    }

    return result.trim();
  }

  console.log('[content.js] 内容脚本初始化完成');
}
