/**
 * popup.js - Popup窗口逻辑
 * 负责：LLM配置管理、测试连接、打开侧边栏
 */

document.addEventListener('DOMContentLoaded', () => {
  const apiUrlInput = document.getElementById('apiUrl');
  const apiKeyInput = document.getElementById('apiKey');
  const modelInput = document.getElementById('model');
  const btnSave = document.getElementById('btnSave');
  const btnTest = document.getElementById('btnTest');
  const btnOpenPanel = document.getElementById('btnOpenPanel');
  const statusEl = document.getElementById('status');

  // 加载已保存的配置（有保存值则覆盖默认值）
  chrome.storage.local.get(['llmApiUrl', 'llmApiKey', 'llmModel'], (result) => {
    if (result.llmApiUrl) apiUrlInput.value = result.llmApiUrl;
    if (result.llmApiKey) apiKeyInput.value = result.llmApiKey;
    if (result.llmModel) modelInput.value = result.llmModel;
    console.log('[popup] 已加载配置');
  });

  // 显示状态
  function showStatus(msg, type) {
    statusEl.className = 'status ' + type;
    statusEl.textContent = msg;
    statusEl.style.display = 'block';
  }

  // 保存配置
  btnSave.addEventListener('click', () => {
    const apiUrl = apiUrlInput.value.trim();
    const apiKey = apiKeyInput.value.trim();
    const model = modelInput.value.trim();

    if (!apiKey) {
      showStatus('请填写 API Key', 'error');
      return;
    }

    chrome.storage.local.set({
      llmApiUrl: apiUrl || 'https://api.deepseek.com',
      llmApiKey: apiKey,
      llmModel: model || 'deepseek-chat'
    }, () => {
      showStatus('✅ 配置已保存', 'success');
      console.log('[popup] 配置已保存');
    });
  });

  // 测试连接
  btnTest.addEventListener('click', () => {
    const apiUrl = apiUrlInput.value.trim() || 'https://api.deepseek.com';
    const apiKey = apiKeyInput.value.trim();
    const model = modelInput.value.trim() || 'deepseek-chat';

    if (!apiKey) {
      showStatus('请先填写 API Key', 'error');
      return;
    }

    showStatus('⏳ 正在测试连接...', 'info');

    chrome.runtime.sendMessage({
      type: 'LLM_REQUEST',
      payload: {
        apiUrl: apiUrl,
        apiKey: apiKey,
        model: model,
        messages: [{ role: 'user', content: 'Hi, reply with OK' }]
      }
    }, (response) => {
      if (chrome.runtime.lastError) {
        showStatus('❌ 通信错误: ' + chrome.runtime.lastError.message, 'error');
        return;
      }
      if (response && response.success) {
        showStatus('✅ 连接成功！模型响应正常', 'success');
      } else if (response && response.error) {
        showStatus('❌ 连接失败: ' + response.error, 'error');
      } else {
        showStatus('❌ 未知错误', 'error');
      }
    });
  });

  // 打开侧边栏
  btnOpenPanel.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'OPEN_SIDE_PANEL' }, (response) => {
      if (chrome.runtime.lastError) {
        showStatus('无法打开侧边栏: ' + chrome.runtime.lastError.message, 'error');
      } else {
        window.close(); // 关闭popup
      }
    });
  });
});
