const { execSync, spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

const OPENCLAW_HOME = path.join(os.homedir(), '.openclaw');

// 查找 openclaw 可执行文件
function findOpenClawPath() {
  const isWin = process.platform === 'win32';

  // 1. 从 PATH 环境变量中搜索
  const pathEnv = process.env.PATH || process.env.Path || process.env.path || '';
  const pathDirs = pathEnv.split(isWin ? ';' : ':');
  const pathCandidates = isWin
    ? ['openclaw.cmd', 'openclaw.exe', 'openclaw.ps1', 'openclaw']
    : ['openclaw'];

  for (const dir of pathDirs) {
    for (const name of pathCandidates) {
      const fullPath = path.join(dir.trim(), name);
      if (fs.existsSync(fullPath)) return fullPath;
    }
  }

  // 2. 尝试 where/which 命令
  const candidates = isWin
    ? ['openclaw.cmd', 'openclaw.exe', 'openclaw']
    : ['openclaw'];

  for (const cmd of candidates) {
    try {
      const result = execSync(`where ${cmd}`, { encoding: 'utf-8', windowsHide: true });
      const p = result.trim().split('\n')[0].trim();
      if (p) return p;
    } catch {
      try {
        const result = execSync(`which ${cmd}`, { encoding: 'utf-8' });
        const p = result.trim().split('\n')[0].trim();
        if (p) return p;
      } catch {}
    }
  }

  // 3. 尝试 npx
  try {
    const npxCmd = isWin ? 'npx.cmd' : 'npx';
    const result = execSync(`${npxCmd} which openclaw`, { encoding: 'utf-8', windowsHide: true });
    const p = result.trim().split('\n')[0].trim();
    if (p) return p;
  } catch {}

  // 4. 尝试常见路径
  const commonPaths = isWin
    ? [
        path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'openclaw.cmd'),
        path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'openclaw.ps1'),
        path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'openclaw'),
        path.join('C:', 'Program Files', 'nodejs', 'openclaw.cmd'),
        path.join('C:', 'Program Files (x86)', 'nodejs', 'openclaw.cmd'),
      ]
    : [
        path.join(os.homedir(), '.npm', 'global', 'bin', 'openclaw'),
        '/usr/local/bin/openclaw',
        '/usr/bin/openclaw',
      ];

  for (const p of commonPaths) {
    if (fs.existsSync(p)) return p;
  }

  return null;
}

let openClawPath = null;

function getOpenClawPath() {
  if (!openClawPath) {
    openClawPath = findOpenClawPath();
  }
  return openClawPath;
}

function runCommandSpawn(cmd, args, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const isWin = process.platform === 'win32';
    const isCmd = isWin && (cmd.endsWith('.cmd') || cmd.endsWith('.bat') || cmd.endsWith('.ps1'));

    // Windows 上执行 .cmd 文件需要特殊处理
    let actualCmd = cmd;
    let actualArgs = args;

    if (isCmd) {
      // 使用 cmd /c 来执行 .cmd 文件
      actualCmd = 'cmd';
      actualArgs = ['/c', cmd, ...args];
    }

    const child = spawn(actualCmd, actualArgs, {
      cwd: OPENCLAW_HOME,
      shell: false,
      windowsHide: true,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' }
    });

    let stdout = '';
    let stderr = '';
    let finished = false;

    const finish = (result, err) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      if (err && !result.trim()) {
        reject(new Error(err));
      } else {
        resolve(result);
      }
    };

    const timeout = setTimeout(() => {
      if (stdout.trim()) {
        finish(stdout);
        killProcessTree(child, isWin);
        return;
      }
      killProcessTree(child, isWin);
      finish('', 'Command timeout');
    }, timeoutMs);

    child.stdout?.on('data', (data) => {
      stdout += data.toString();
    });
    child.stderr?.on('data', (data) => {
      stderr += data.toString();
    });
    child.on('close', (code) => {
      finish(stdout, code === 0 ? undefined : (stderr || `Exit code ${code}`));
    });
    child.on('error', (err) => {
      finish(stdout, err.message);
    });
  });
}

function killProcessTree(child, isWin) {
  if (!child.pid) return;
  try {
    if (isWin) {
      execSync(`taskkill /pid ${child.pid} /T /F`, { windowsHide: true });
    } else {
      child.kill('SIGKILL');
    }
  } catch {}
}

async function runJsonCommand(args, timeoutMs = 30000) {
  const cmdPath = getOpenClawPath();
  if (!cmdPath) {
    return null;
  }

  try {
    const output = await runCommandSpawn(cmdPath, args, timeoutMs);
    const trimmed = output.trim();
    if (!trimmed) return null;
    return JSON.parse(trimmed);
  } catch (e) {
    return null;
  }
}

let cachedVersion = '';

async function getOpenClawVersion() {
  if (cachedVersion) return cachedVersion;

  // 尝试 package.json
  const possiblePaths = [
    path.join(OPENCLAW_HOME, 'package.json'),
    path.join(os.homedir(), '.config', 'openclaw', 'package.json')
  ];
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(p, 'utf-8'));
        if (pkg.version) {
          cachedVersion = pkg.version;
          return cachedVersion;
        }
      } catch {}
    }
  }

  const cmdPath = getOpenClawPath();
  if (cmdPath) {
    try {
      const output = await runCommandSpawn(cmdPath, ['--version'], 10000);
      const match = output.match(/(\d+\.\d+\.\d+)/);
      if (match) {
        cachedVersion = match[1];
        return cachedVersion;
      }
      if (output.trim()) {
        cachedVersion = output.trim();
        return cachedVersion;
      }
    } catch {}

    try {
      const data = await runJsonCommand(['version'], 10000);
      if (data && typeof data === 'string') {
        cachedVersion = data.trim();
        return cachedVersion;
      }
      if (data?.version) {
        cachedVersion = String(data.version);
        return cachedVersion;
      }
    } catch {}
  }

  cachedVersion = 'unknown';
  return cachedVersion;
}

let lastSessions = [];
let lastCronJobs = [];
let lastApprovals = null;

async function collectSessions() {
  const data = await runJsonCommand(['sessions', '--json'], 30000);
  if (data?.sessions) {
    const sessions = data.sessions.map((s) => ({
      ...s,
      sessionKey: s.key || s.sessionKey || '',
      state: s.state || 'idle',
      label: s.label || s.sessionId || s.key || '',
      lastMessageAt: s.lastMessageAt || s.updatedAt
    }));
    lastSessions = sessions;
    return sessions;
  }

  // 回退：从文件系统读取
  if (lastSessions.length === 0) {
    const contexts = await collectSessionsContexts();
    if (contexts.length > 0) {
      lastSessions = contexts.map((ctx) => ({
        sessionKey: ctx.sessionKey,
        key: ctx.sessionKey,
        sessionId: ctx.sessionId,
        agentId: ctx.agentId,
        model: ctx.model,
        modelProvider: ctx.modelProvider,
        contextTokens: ctx.contextTokens,
        totalTokens: ctx.totalTokens,
        state: 'idle',
        label: ctx.sessionId || ctx.sessionKey,
        lastMessageAt: null,
        updatedAt: null
      }));
    }
  }

  return lastSessions;
}

async function collectCronJobs() {
  const data = await runJsonCommand(['cron', 'list', '--json'], 30000);
  if (data?.jobs) {
    const jobs = data.jobs.map((job) => {
      if (!job.jobId && job.id) job.jobId = job.id;
      if (!job.nextRunAt && job.schedule) {
        const schedule = job.schedule;
        if (schedule.kind === 'every' && schedule.everyMs > 0 && schedule.anchorMs > 0) {
          const now = Date.now();
          const elapsed = now - schedule.anchorMs;
          job.nextRunAt = schedule.anchorMs + (Math.floor(elapsed / schedule.everyMs) + 1) * schedule.everyMs;
        } else if (schedule.kind === 'cron') {
          job.nextRunAt = null;
        }
      }
      if (typeof job.enabled === 'undefined') {
        job.enabled = ['enabled', 'active', true].includes(job.status);
      }
      return job;
    });
    lastCronJobs = jobs;
    return jobs;
  }
  return lastCronJobs;
}

async function collectApprovals() {
  const data = await runJsonCommand(['approvals', 'get', '--json'], 30000);
  if (data) {
    lastApprovals = data;
    return data;
  }
  return lastApprovals;
}

async function collectSessionsContexts() {
  const contexts = [];
  const agentsDir = path.join(OPENCLAW_HOME, 'agents');
  if (!fs.existsSync(agentsDir)) return contexts;

  for (const agentName of fs.readdirSync(agentsDir)) {
    const agentDir = path.join(agentsDir, agentName);
    const sessionsIndex = path.join(agentDir, 'sessions', 'sessions.json');
    if (!fs.existsSync(sessionsIndex)) continue;

    try {
      const data = JSON.parse(fs.readFileSync(sessionsIndex, 'utf-8'));
      for (const [sessionKey, value] of Object.entries(data)) {
        if (typeof value !== 'object' || value === null) continue;
        const v = value;
        const meta = v.meta || {};
        contexts.push({
          sessionKey,
          sessionId: v.sessionId,
          agentId: agentName,
          model: v.model,
          modelProvider: v.modelProvider,
          contextTokens: v.contextTokens,
          totalTokens: v.totalTokens,
          channel: v.channel || v.lastChannel || meta.channel || meta.provider,
          surface: meta.surface
        });
      }
    } catch {}
  }

  return contexts;
}

async function collectUsageEvents() {
  const events = [];
  const agentsDir = path.join(OPENCLAW_HOME, 'agents');
  if (!fs.existsSync(agentsDir)) return events;

  const lookbackTimestamp = Date.now() - 7 * 24 * 60 * 60 * 1000;

  for (const agentName of fs.readdirSync(agentsDir)) {
    const agentDir = path.join(agentsDir, agentName);
    const sessionsDir = path.join(agentDir, 'sessions');
    if (!fs.existsSync(sessionsDir)) continue;

    // 读取 session 映射
    const sessionKeyMap = {};
    const sessionsIndex = path.join(sessionsDir, 'sessions.json');
    if (fs.existsSync(sessionsIndex)) {
      try {
        const data = JSON.parse(fs.readFileSync(sessionsIndex, 'utf-8'));
        for (const [sessionKey, value] of Object.entries(data)) {
          const v = value;
          if (v?.sessionId) sessionKeyMap[v.sessionId] = sessionKey;
        }
      } catch {}
    }

    // 读取 jsonl 文件
    for (const file of fs.readdirSync(sessionsDir)) {
      if (!file.endsWith('.jsonl')) continue;
      const filePath = path.join(sessionsDir, file);
      try {
        const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const record = JSON.parse(trimmed);
            if (record.type !== 'message') continue;
            const message = record.message || {};
            if (message.role !== 'assistant') continue;
            const usage = message.usage;
            if (!usage) continue;

            const timestampStr = record.timestamp || message.timestamp;
            if (!timestampStr) continue;

            const ts = new Date(timestampStr.replace('Z', '+00:00'));
            if (isNaN(ts.getTime()) || ts.getTime() < lookbackTimestamp) continue;

            const sessionId = file.replace('.jsonl', '');
            const costInfo = usage.cost || {};

            events.push({
              timestamp: ts.toISOString(),
              day: ts.toISOString().split('T')[0],
              sessionId,
              sessionKey: sessionKeyMap[sessionId],
              agentId: agentName,
              model: message.model,
              provider: message.provider,
              tokens: usage.totalTokens || (usage.input || 0) + (usage.output || 0),
              cost: costInfo.total || 0
            });
          } catch {}
        }
      } catch {}
    }
  }

  return events;
}

async function collectProjects() {
  const p = path.join(OPENCLAW_HOME, 'projects', 'projects.json');
  if (!fs.existsSync(p)) return { projects: [], updatedAt: '' };
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
    return {
      projects: data.projects || [],
      updatedAt: data.updatedAt || ''
    };
  } catch {
    return { projects: [], updatedAt: '' };
  }
}

async function collectTasks() {
  const p = path.join(OPENCLAW_HOME, 'tasks', 'tasks.json');
  if (!fs.existsSync(p)) return { tasks: [], agentBudgets: [], updatedAt: '' };
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
    return {
      tasks: data.tasks || [],
      agentBudgets: data.agentBudgets || [],
      updatedAt: data.updatedAt || ''
    };
  } catch {
    return { tasks: [], agentBudgets: [], updatedAt: '' };
  }
}

async function collectRuntimeData() {
  const [sessionsContexts, usageEvents, projects, tasks] = await Promise.all([
    collectSessionsContexts(),
    collectUsageEvents(),
    collectProjects(),
    collectTasks()
  ]);

  return {
    sessionsContexts,
    usageEvents,
    projects,
    tasks,
    projectSummaries: []
  };
}

function buildSessionStatuses(sessions) {
  return sessions.map((s) => ({
    sessionKey: s.sessionKey || s.key || '',
    model: s.model,
    tokensIn: s.inputTokens || 0,
    tokensOut: s.outputTokens || 0,
    cost: null,
    updatedAt: s.updatedAt || ''
  }));
}

function buildApprovals(approvalsData) {
  if (!approvalsData) return [];
  if (Array.isArray(approvalsData.approvals)) return approvalsData.approvals;
  for (const key of ['items', 'records', 'pending']) {
    if (Array.isArray(approvalsData[key])) return approvalsData[key];
  }
  return [];
}

function buildBudgetSummary(sessions, sessionStatuses, tasks, projects) {
  const evaluations = [];
  const totalTokens = sessionStatuses.reduce((sum, s) => sum + (s.tokensIn || 0) + (s.tokensOut || 0), 0);

  return {
    total: totalTokens,
    ok: totalTokens > 0 ? 1 : 0,
    warn: 0,
    over: 0,
    evaluations
  };
}

function buildDiagnostics(version, gatewayStatus, sessions = []) {
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

  return {
    generatedAt: new Date().toISOString(),
    app: { name: 'OpenClaw', version },
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
      currentVersion: version,
      updateAvailable: false
    },
    tokens: { redacted: true, localTokenAuthRequired: false, entries: [] },
    recentIssues
  };
}

async function collectDashboardData() {
  const [sessions, cronJobs, approvals, runtimeData, version] = await Promise.all([
    collectSessions(),
    collectCronJobs(),
    collectApprovals(),
    collectRuntimeData(),
    getOpenClawVersion()
  ]);

  const sessionStatuses = buildSessionStatuses(sessions);
  const projects = runtimeData.projects;
  const tasks = runtimeData.tasks;

  // 简单网关状态检测
  let gatewayStatus = 'unknown';
  try {
    const net = require('net');
    await new Promise((resolve) => {
      const sock = new net.Socket();
      sock.setTimeout(2000);
      sock.once('connect', () => {
        gatewayStatus = 'ok';
        sock.destroy();
        resolve();
      });
      sock.once('error', () => {
        sock.destroy();
        resolve();
      });
      sock.connect(18789, '127.0.0.1');
    });
  } catch {}

  return {
    sessions,
    sessionStatuses,
    cronJobs,
    approvals: buildApprovals(approvals),
    projects,
    tasks,
    projectSummaries: runtimeData.projectSummaries,
    tasksSummary: {
      projects: projects.projects?.length || 0,
      tasks: tasks.tasks?.length || 0,
      todo: 0,
      inProgress: 0,
      blocked: 0,
      done: 0,
      owners: 0,
      artifacts: 0
    },
    budgetSummary: buildBudgetSummary(sessions, sessionStatuses, tasks, projects),
    diagnostics: buildDiagnostics(version, gatewayStatus, sessions),
    sessionsContexts: runtimeData.sessionsContexts,
    usageEvents: runtimeData.usageEvents
  };
}

module.exports = {
  collectDashboardData
};