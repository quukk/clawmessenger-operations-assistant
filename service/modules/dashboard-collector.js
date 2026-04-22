const http = require('http');

const GATEWAY_URL = 'http://127.0.0.1:4096';

// 使用 Node.js 原生 http 模块避免 JSDOM CORS 限制
function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: 5000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve([]);
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });
  });
}

async function collectDashboardData() {
  const data = {
    sessions: [],
    sessionStatuses: [],
    cronJobs: [],
    approvals: [],
    projects: [],
    tasks: [],
    projectSummaries: [],
    tasksSummary: {},
    budgetSummary: {},
    diagnostics: {},
    sessionsContexts: [],
    usageEvents: []
  };

  const endpoints = [
    { key: 'sessions', url: '/api/sessions' },
    { key: 'sessionStatuses', url: '/api/session-statuses' },
    { key: 'cronJobs', url: '/api/cron-jobs' },
    { key: 'approvals', url: '/api/approvals' },
    { key: 'projects', url: '/api/projects' },
    { key: 'tasks', url: '/api/tasks' },
    { key: 'projectSummaries', url: '/api/project-summaries' },
    { key: 'tasksSummary', url: '/api/tasks-summary' },
    { key: 'budgetSummary', url: '/api/budget-summary' },
    { key: 'diagnostics', url: '/api/diagnostics' },
    { key: 'sessionsContexts', url: '/api/sessions-contexts' },
    { key: 'usageEvents', url: '/api/usage-events' }
  ];

  for (const endpoint of endpoints) {
    try {
      const result = await httpGet(`${GATEWAY_URL}${endpoint.url}`);
      const fallback = Array.isArray(data[endpoint.key]) ? [] : {};
      if (result !== undefined && result !== null) {
        data[endpoint.key] = result;
      } else {
        data[endpoint.key] = fallback;
      }
    } catch (e) {
      console.error(`获取 ${endpoint.key} 失败:`, e.message);
    }
  }

  if (!data.diagnostics || typeof data.diagnostics !== 'object') {
    data.diagnostics = {};
  }
  data.diagnostics.generatedAt = new Date().toISOString();
  return data;
}

module.exports = {
  collectDashboardData
};
