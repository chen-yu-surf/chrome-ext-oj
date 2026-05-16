/**
 * background.js - Service Worker
 * 负责：管理侧边栏、消息路由、图标状态控制
 */

// 监听标签页更新，控制图标状态
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url) {
    const isProblemPage = tab.url.match(/^http:\/\/jx\.7fa4\.cn:8888\/problem\/.+/);
    if (isProblemPage) {
      // 题目页面：图标可用（使用Chrome默认图标，enable/disable控制灰色状态）
      chrome.action.enable(tabId);
    } else {
      // 非题目页面：图标置灰不可用
      chrome.action.disable(tabId);
    }
  }
});

// 监听标签页激活切换
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    if (tab.url) {
      const isProblemPage = tab.url.match(/^http:\/\/jx\.7fa4\.cn:8888\/problem\/.+/);
      if (isProblemPage) {
        chrome.action.enable(activeInfo.tabId);
      } else {
        chrome.action.disable(activeInfo.tabId);
      }
    }
  } catch (e) {
    console.error('[background] onActivated error:', e);
  }
});

// 消息路由：侧边栏请求题目数据时，主动注入content script并获取数据
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('[background] received message:', message);

  if (message.type === 'OPEN_SIDE_PANEL') {
    // 打开侧边栏
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        chrome.sidePanel.open({ tabId: tabs[0].id });
      }
    });
    sendResponse({ success: true });
    return true;
  }

  if (message.type === 'GET_PROBLEM_DATA') {
    // 侧边栏请求题目数据 - 主动注入脚本方案解决"接收端不存在"问题
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      if (!tabs[0]) {
        sendResponse({ error: '无法获取当前标签页' });
        return;
      }
      const tab = tabs[0];
      if (!tab.url || !tab.url.match(/^http:\/\/jx\.7fa4\.cn:8888\/problem\/.+/)) {
        sendResponse({ error: '当前页面不是题目页面' });
        return;
      }

      try {
        // 主动注入content script，确保脚本存在
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content.js']
        });
        console.log('[background] content script injected successfully');

        // 短暂延迟确保注入完成
        setTimeout(() => {
          chrome.tabs.sendMessage(tab.id, { type: 'EXTRACT_PROBLEM' }, (response) => {
            if (chrome.runtime.lastError) {
              console.error('[background] sendMessage error:', chrome.runtime.lastError);
              sendResponse({ error: '内容脚本通信失败: ' + chrome.runtime.lastError.message });
            } else {
              console.log('[background] got problem data:', response);
              sendResponse(response);
            }
          });
        }, 200);
      } catch (e) {
        console.error('[background] script injection error:', e);
        sendResponse({ error: '脚本注入失败: ' + e.message });
      }
    });
    return true; // 保持异步sendResponse通道
  }

  if (message.type === 'LLM_REQUEST') {
    // 代理LLM请求（解决CORS问题）
    handleLLMRequest(message.payload)
      .then(response => sendResponse(response))
      .catch(error => sendResponse({ error: error.message }));
    return true;
  }

  if (message.type === 'LLM_STREAM_REQUEST') {
    // 流式请求 - 通过端口通信
    handleStreamRequest(message.payload, sender);
    sendResponse({ started: true });
    return true;
  }
});

// 处理LLM普通请求（用于测试连接）
async function handleLLMRequest(payload) {
  const { apiUrl, apiKey, model, messages } = payload;
  let url = apiUrl.trim();

  // 自动补全后缀：仅当路径中不包含 /chat/completions 时补全
  if (!url.includes('/chat/completions')) {
    url = url.replace(/\/+$/, ''); // 去除尾部斜杠
    url += '/chat/completions';
  }

  console.log('[background] LLM request to:', url);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: model,
        messages: messages,
        max_tokens: 100
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errText}`);
    }

    const data = await response.json();
    return { success: true, data: data };
  } catch (e) {
    // 自动补全重试
    console.error('[background] LLM request failed:', e.message);
    throw e;
  }
}

// 处理流式请求
async function handleStreamRequest(payload, sender) {
  const { apiUrl, apiKey, model, messages, requestId } = payload;
  let url = apiUrl.trim();

  // 自动补全后缀：仅当路径中不包含 /chat/completions 时补全
  if (!url.includes('/chat/completions')) {
    url = url.replace(/\/+$/, ''); // 去除尾部斜杠
    url += '/chat/completions';
  }

  console.log('[background] Stream request to:', url);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: model,
        messages: messages,
        stream: true
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      // 发送错误到sidepanel
      chrome.runtime.sendMessage({
        type: 'STREAM_ERROR',
        requestId: requestId,
        error: `HTTP ${response.status}: ${errText}`
      });
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let sseBuffer = ''; // 缓冲区，处理跨chunk的不完整行

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        chrome.runtime.sendMessage({
          type: 'STREAM_DONE',
          requestId: requestId
        });
        break;
      }

      sseBuffer += decoder.decode(value, { stream: true });
      const lines = sseBuffer.split('\n');
      // 最后一个元素可能是不完整的行，保留到下次
      sseBuffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('data: ')) {
          const data = trimmed.slice(6).trim();
          if (data === '[DONE]') {
            chrome.runtime.sendMessage({
              type: 'STREAM_DONE',
              requestId: requestId
            });
            return;
          }
          try {
            const parsed = JSON.parse(data);
            const content = parsed.choices?.[0]?.delta?.content || '';
            if (content) {
              chrome.runtime.sendMessage({
                type: 'STREAM_CHUNK',
                requestId: requestId,
                content: content
              });
            }
          } catch (e) {
            // 忽略解析失败的行（可能是不完整的JSON）
            console.warn('[background] SSE parse skip:', trimmed.substring(0, 100));
          }
        }
      }
    }
  } catch (e) {
    console.error('[background] Stream error:', e);
    chrome.runtime.sendMessage({
      type: 'STREAM_ERROR',
      requestId: requestId,
      error: e.message
    });
  }
}

console.log('[background] Service worker loaded');
