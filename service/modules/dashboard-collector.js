const http = require('http');
const os = require('os');

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

function buildDiagnostics(sessions = []) {
  const recentIssues = sessions
    .slice(0, 5)
    .map((s) => {
      const updatedAt = s.updatedAt || s.lastMessageAt;
      if (!updatedAt) return null;
      return {
        timestamp: typeof updatedAt === 'number' ? new Date(updatedAt).toISOString() : updatedAt,
        action: '会话活动',
        detail: `${s.label || s.sessionKey || 'Unknown'} - ${s.state || 'idle'}`
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  // 检测网关状态
  let gatewayStatus = 'unknown';
  try {
    const net = require('net');
    const sock = new net.Socket();
    sock.setTimeout(2000);
    sock.once('connect', () => {
      gatewayStatus = 'ok';
      sock.destroy();
    });
    sock.once('error', () => {
      sock.destroy();
    });
    sock.connect(18789, '127.0.0.1');
  } catch {}

  return {
    generatedAt: new Date().toISOString(),
    app: { name: 'OpenClaw', version: 'unknown' },
    runtime: {
      platform: os.platform(),
      arch: process.arch,
      cpuCount: os.cpus().length,
      totalMemoryBytes: os.totalmem(),
      freeMemoryBytes: os.freemem(),
      uptimeSeconds: Math.floor(os.uptime())
    },
    gateway: {
      configuredUrl: 'ws://127.0.0.1:18789',
      overallStatus: gatewayStatus
    },
    openclaw: {
      status: 'ok',
      currentVersion: 'unknown',
      updateAvailable: false
    },
    tokens: { redacted: true, localTokenAuthRequired: false, entries: [] },
    recentIssues
  };
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

  // 确保 diagnostics 包含必要的字段
  if (!data.diagnostics || typeof data.diagnostics !== 'object' || !data.diagnostics.gateway) {
    data.diagnostics = buildDiagnostics(data.sessions);
  }
  data.diagnostics.generatedAt = new Date().toISOString();
  return data;
}

module.exports = {
  collectDashboardData
};
