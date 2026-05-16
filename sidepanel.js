/**
 * sidepanel.js - 侧边栏面板逻辑
 * 负责：对话交互、LLM通信、Markdown/LaTeX渲染、流式输出
 */

(function () {
  'use strict';

  // ======================= 全局变量 =======================
  let problemData = null;       // 当前题目数据
  let conversationHistory = []; // 对话历史
  let currentRequestId = null;  // 当前流式请求ID
  let isStreaming = false;      // 是否正在流式接收
  let currentStreamContent = ''; // 当前流式累积内容
  let currentStreamEl = null;   // 当前流式消息DOM元素

  // ======================= DOM 引用 =======================
  const chatContainer = document.getElementById('chatContainer');
  const userInput = document.getElementById('userInput');
  const btnSend = document.getElementById('btnSend');
  const btnClear = document.getElementById('btnClear');
  const btnDebug = document.getElementById('btnDebug');
  const btnRefresh = document.getElementById('btnRefresh');
  const problemTitle = document.getElementById('problemTitle');
  const debugPanel = document.getElementById('debugPanel');
  const debugContent = document.getElementById('debugContent');
  const btnCloseDebug = document.getElementById('btnCloseDebug');

  // ======================= 调试日志 =======================
  function debugLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString();
    const line = document.createElement('div');
    line.className = 'debug-line debug-' + type;
    line.textContent = `[${time}] [${type.toUpperCase()}] ${msg}`;
    debugContent.appendChild(line);
    debugContent.scrollTop = debugContent.scrollHeight;
    console.log(`[sidepanel][${type}]`, msg);
  }

  // ======================= 导师系统提示词 =======================
  // 从 mentor.md 文件加载，这里定义默认值
  const MENTOR_SYSTEM_PROMPT = `你是一位经验丰富的编程竞赛辅导老师。你的职责是：

1. 分析学生遇到的编程竞赛题目，理解题意和关键约束
2. 不直接给出完整代码答案，而是引导学生思考
3. 使用启发式教学法，通过提问和提示帮助学生理解算法思路
4. 当学生请求提示时，逐步给出解题思路，从大方向到细节
5. 如果学生确实需要代码参考，给出关键算法伪代码或核心代码片段
6. 对学生的解法给出建设性的评价和优化建议
7. 回答中涉及数学公式时使用LaTeX格式（$...$或$$...$$）
8. 代码使用Markdown代码块格式

当前辅导规则：
- 优先使用中文回答
- 结合题目的具体数据范围分析时间复杂度要求
- 涉及算法分类时说明常见解法及其适用条件
- 鼓励学生独立思考，不要一次性给出全部答案`;

  // ======================= 初始化 =======================
  async function init() {
    debugLog('侧边栏初始化开始');

    // 加载mentor.md自定义提示词
    await loadMentorPrompt();

    // 自动获取题目数据
    fetchProblemData();

    // 绑定事件
    btnSend.addEventListener('click', handleSend);
    userInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    });
    btnClear.addEventListener('click', clearConversation);
    btnDebug.addEventListener('click', () => {
      debugPanel.style.display = debugPanel.style.display === 'none' ? 'block' : 'none';
    });
    btnCloseDebug.addEventListener('click', () => {
      debugPanel.style.display = 'none';
    });
    btnRefresh.addEventListener('click', fetchProblemData);
    // 监听流式消息
    chrome.runtime.onMessage.addListener(handleStreamMessage);

    debugLog('侧边栏初始化完成');
  }

  // ===================== 加载 mentor.md =====================
  let mentorPrompt = MENTOR_SYSTEM_PROMPT;

  async function loadMentorPrompt() {
    try {
      const promptFiles = ['mentor.md', 'idea.md', 'codereview.md', 'summary.md'];
      const parts = [];
      for (const file of promptFiles) {
        try {
          const url = chrome.runtime.getURL(file);
          const response = await fetch(url);
          if (response.ok) {
            const text = await response.text();
            if (text.trim()) {
              parts.push(text.trim());
            }
          }
        } catch (e) {
          debugLog(`加载 ${file} 失败: ${e.message}`, 'warn');
        }
      }
      if (parts.length > 0) {
        mentorPrompt = parts.join('\n\n---\n\n');
        debugLog(`已加载自定义提示词 (${parts.length} 个文件)`);
        return;
      }
    } catch (e) {
      debugLog('加载提示词文件失败，使用默认提示词: ' + e.message, 'warn');
    }
    mentorPrompt = MENTOR_SYSTEM_PROMPT;
  }

  // ======================= 获取题目数据 =======================
  function fetchProblemData() {
    debugLog('请求获取题目数据...');
    problemTitle.textContent = '正在获取题目...';

    chrome.runtime.sendMessage({ type: 'GET_PROBLEM_DATA' }, (response) => {
      if (chrome.runtime.lastError) {
        debugLog('获取题目失败: ' + chrome.runtime.lastError.message, 'error');
        problemTitle.textContent = '❌ 获取失败（请确保在题目页面）';
        return;
      }

      if (response && response.success) {
        problemData = response;
        problemTitle.textContent = '📋 ' + response.title;
        debugLog('题目获取成功: ' + response.title);
        debugLog('题目内容长度: ' + (response.content || '').length + ' 字符');

        // 初始化对话上下文
        conversationHistory = [
          {
            role: 'system',
            content: mentorPrompt
          },
          {
            role: 'system',
            content: `当前题目信息：\n标题：${response.title}\n题目ID：${response.problemId}\n\n题目内容：\n${response.content}`
          }
        ];
        debugLog('对话上下文已初始化');

        // 自动发起AI开场问候
        autoGreet(response.title);
      } else if (response && response.error) {
        debugLog('获取题目失败: ' + response.error, 'error');
        problemTitle.textContent = '❌ ' + response.error;
      } else {
        debugLog('获取题目返回异常', 'error');
        problemTitle.textContent = '❌ 获取异常';
      }
    });
  }

  // ======================= AI自动开场 =======================
  async function autoGreet(title) {
    const config = await getConfig();
    if (!config.llmApiUrl || !config.llmApiKey || !config.llmModel) {
      // 未配置LLM，显示静态欢迎
      appendMessage('assistant', `同学你好！我看到你在做 **${title}**。\n\n请先点击插件图标配置 LLM API 信息，配置完成后刷新面板即可开始辅导。`);
      return;
    }

    // 添加一条隐式用户消息触发AI开场（不显示在界面上）
    conversationHistory.push({
      role: 'user',
      content: '我刚打开这道题。请你只用1-2句话和我打个招呼，告诉我这道题的难度级别（CSP-J入门/CSP-S提高），然后直接问我"你目前有自己的解题思路吗？"。注意：不要透露任何考点、算法方向、解题思路或分析，只说难度和打招呼。'
    });

    // 创建AI消息占位
    const aiMsgEl = appendMessage('assistant', '');
    currentStreamEl = aiMsgEl.querySelector('.msg-content');
    currentStreamContent = '';
    isStreaming = true;
    currentRequestId = 'req_greet_' + Date.now();
    btnSend.disabled = true;
    btnSend.textContent = '⏳';

    debugLog('自动发起AI开场问候');

    chrome.runtime.sendMessage({
      type: 'LLM_STREAM_REQUEST',
      payload: {
        apiUrl: config.llmApiUrl,
        apiKey: config.llmApiKey,
        model: config.llmModel,
        messages: conversationHistory,
        requestId: currentRequestId
      }
    }, (response) => {
      if (chrome.runtime.lastError) {
        debugLog('开场请求失败: ' + chrome.runtime.lastError.message, 'error');
        currentStreamEl.innerHTML = '<span class="error-text">开场请求失败: ' + escapeHtml(chrome.runtime.lastError.message) + '</span>';
        finishStream();
      }
    });
  }

  // ======================= 发送消息 =======================
  async function handleSend() {
    const text = userInput.value.trim();
    if (!text) return;
    if (isStreaming) {
      debugLog('正在等待AI回复，请稍候', 'warn');
      return;
    }

    // 获取LLM配置
    const config = await getConfig();
    if (!config.llmApiUrl || !config.llmApiKey || !config.llmModel) {
      debugLog('请先在Popup中配置LLM API信息', 'error');
      appendMessage('system', '⚠️ 请先点击插件图标配置 LLM API 信息（API网址、Key、Model）');
      return;
    }

    // 显示用户消息
    appendMessage('user', text);
    userInput.value = '';

    // 添加到对话历史
    conversationHistory.push({ role: 'user', content: text });

    // 创建AI消息占位
    const aiMsgEl = appendMessage('assistant', '');
    currentStreamEl = aiMsgEl.querySelector('.msg-content');
    currentStreamContent = '';

    // 发起流式请求
    isStreaming = true;
    currentRequestId = 'req_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    btnSend.disabled = true;
    btnSend.textContent = '⏳';

    debugLog(`发送LLM请求 [${currentRequestId}], 消息数: ${conversationHistory.length}`);

    chrome.runtime.sendMessage({
      type: 'LLM_STREAM_REQUEST',
      payload: {
        apiUrl: config.llmApiUrl,
        apiKey: config.llmApiKey,
        model: config.llmModel,
        messages: conversationHistory,
        requestId: currentRequestId
      }
    }, (response) => {
      if (chrome.runtime.lastError) {
        debugLog('流式请求启动失败: ' + chrome.runtime.lastError.message, 'error');
        currentStreamEl.innerHTML = '<span class="error-text">请求失败: ' + escapeHtml(chrome.runtime.lastError.message) + '</span>';
        finishStream();
      }
    });
  }

  // ======================= 流式消息处理 =======================
  function handleStreamMessage(message) {
    if (!message.requestId || message.requestId !== currentRequestId) return;

    if (message.type === 'STREAM_CHUNK') {
      currentStreamContent += message.content;
      renderStreamContent();
    }

    if (message.type === 'STREAM_DONE') {
      debugLog('流式接收完成，总长度: ' + currentStreamContent.length);
      // 最终渲染
      renderStreamContent(true);
      // 保存到对话历史
      if (currentStreamContent) {
        conversationHistory.push({ role: 'assistant', content: currentStreamContent });
      }
      finishStream();
    }

    if (message.type === 'STREAM_ERROR') {
      debugLog('流式请求错误: ' + message.error, 'error');
      if (currentStreamEl) {
        currentStreamEl.innerHTML = '<span class="error-text">❌ 请求错误: ' + escapeHtml(message.error) + '</span>';
      }
      finishStream();
    }
  }

  function finishStream() {
    isStreaming = false;
    currentRequestId = null;
    currentStreamEl = null;
    btnSend.disabled = false;
    btnSend.textContent = '发送';
  }

  // ======================= KaTeX 公式渲染工具 =======================
  /**
   * 使用 KaTeX 将 LaTeX 字符串渲染为 HTML。
   * KaTeX 不使用 eval，完全兼容 Chrome Extension MV3 CSP。
   */
  function renderLatexToHTML(latex, displayMode) {
    if (typeof katex === 'undefined') {
      debugLog('KaTeX 未加载，公式将以原文显示', 'warn');
      return escapeHtml(latex);
    }
    try {
      return katex.renderToString(latex, {
        displayMode: displayMode,
        throwOnError: false,  // 解析失败时显示红色原文而非抛异常
        trust: true,
        strict: false
      });
    } catch (e) {
      debugLog('KaTeX 渲染失败: ' + e.message + ' => ' + latex.substring(0, 60), 'warn');
      return '<span class="katex-error" style="color:#d93025;">' + escapeHtml(latex) + '</span>';
    }
  }

  // ======================= LaTeX保护：防止marked破坏公式 =======================
  /**
   * 核心问题：marked.js 会把 LaTeX 中的 _ 解析为 <em>，\ 被吞掉等。
   * 方案：
   *  1. 提取所有LaTeX公式，用KaTeX直接渲染为HTML
   *  2. 将渲染后的HTML作为占位符内容
   *  3. marked处理纯Markdown后还原已渲染的公式HTML
   */
  function extractLatex(text) {
    const placeholders = [];
    let idx = 0;

    // 替换函数：提取公式内容，用KaTeX渲染为HTML，存入占位符
    function makeReplacer(displayMode) {
      return function(match, inner) {
        const ph = `%%LATEX_PH_${idx}%%`;
        const rendered = renderLatexToHTML(inner, displayMode);
        placeholders.push({ ph, html: rendered });
        idx++;
        return ph;
      };
    }

    // 顺序很重要：先匹配长定界符，再匹配短的
    // 1. $$ ... $$（多行display math）
    text = text.replace(/\$\$([\s\S]+?)\$\$/g, makeReplacer(true));
    // 2. \[ ... \]（display math）
    text = text.replace(/\\\[([\s\S]+?)\\\]/g, makeReplacer(true));
    // 3. \( ... \)（inline math）
    text = text.replace(/\\\(([\s\S]+?)\\\)/g, makeReplacer(false));
    // 4. $ ... $（inline math，不跨行，不匹配 $$ ）
    text = text.replace(/(?<!\$)\$(?!\$)((?:\\\$|[^$\n])+?)\$(?!\$)/g, makeReplacer(false));

    return { text, placeholders };
  }

  function restoreLatex(html, placeholders) {
    for (const { ph, html: rendered } of placeholders) {
      // 占位符可能被marked包裹在<p>等标签中，用全局替换
      html = html.split(ph).join(rendered);
    }
    return html;
  }

  // ======================= Markdown + LaTeX 安全渲染 =======================
  function renderMarkdownSafe(text) {
    // 第1步：提取LaTeX到占位符
    const { text: safeText, placeholders } = extractLatex(text);

    // 第2步：用marked渲染Markdown
    let html = '';
    if (typeof marked !== 'undefined' && typeof marked.parse === 'function') {
      html = marked.parse(safeText, { breaks: true, gfm: true });
    } else if (typeof marked === 'function') {
      html = marked(safeText);
    } else {
      html = escapeHtml(safeText).replace(/\n/g, '<br>');
    }

    // 第3步：还原LaTeX公式
    html = restoreLatex(html, placeholders);
    return html;
  }

  // ======================= 渲染流式内容 =======================
  function renderStreamContent(isFinal = false) {
    if (!currentStreamEl) return;

    try {
      // renderMarkdownSafe 内部已用 KaTeX 渲染公式，无需额外排版
      currentStreamEl.innerHTML = renderMarkdownSafe(currentStreamContent);
    } catch (e) {
      debugLog('渲染错误: ' + e.message, 'error');
      currentStreamEl.innerHTML = escapeHtml(currentStreamContent).replace(/\n/g, '<br>');
    }

    // 滚动到底部
    chatContainer.scrollTop = chatContainer.scrollHeight;
  }

  // ======================= 消息展示 =======================
  function appendMessage(role, content) {
    // 移除欢迎消息
    const welcome = chatContainer.querySelector('.welcome-msg');
    if (welcome) welcome.remove();

    const msgDiv = document.createElement('div');
    msgDiv.className = 'chat-msg msg-' + role;

    const labelDiv = document.createElement('div');
    labelDiv.className = 'msg-label';
    labelDiv.textContent = role === 'user' ? '你' : role === 'assistant' ? '助手' : '系统';

    const contentDiv = document.createElement('div');
    contentDiv.className = 'msg-content';

    if (content) {
      if (role === 'user' || role === 'system') {
        contentDiv.textContent = content;
      } else {
        // AI消息使用Markdown + LaTeX安全渲染
        try {
          contentDiv.innerHTML = renderMarkdownSafe(content);
        } catch (e) {
          contentDiv.textContent = content;
        }
      }
    }

    msgDiv.appendChild(labelDiv);
    msgDiv.appendChild(contentDiv);
    chatContainer.appendChild(msgDiv);
    chatContainer.scrollTop = chatContainer.scrollHeight;

    return msgDiv;
  }

  // ======================= 清空对话 =======================
  function clearConversation() {
    chatContainer.innerHTML = '<div class="welcome-msg"><p>👋 对话已清空，重新开始吧</p></div>';
    // 重置对话历史，保留系统提示和题目信息
    if (problemData) {
      conversationHistory = [
        { role: 'system', content: mentorPrompt },
        {
          role: 'system',
          content: `当前题目信息：\n标题：${problemData.title}\n题目ID：${problemData.problemId}\n\n题目内容：\n${problemData.content}`
        }
      ];
    } else {
      conversationHistory = [{ role: 'system', content: mentorPrompt }];
    }
    debugLog('对话已清空');
  }

  // ======================= 工具函数 =======================
  function getConfig() {
    return new Promise((resolve) => {
      chrome.storage.local.get(['llmApiUrl', 'llmApiKey', 'llmModel'], (result) => {
        resolve(result);
      });
    });
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ======================= 启动 =======================
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
