const { collectDashboardData } = require('../../service/modules/dashboard-collector');
const axios = require('axios');

jest.mock('axios');

describe('Dashboard Collector Module', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    console.error = jest.fn();
  });

  test('returns an object with all required fields', async () => {
    axios.get.mockResolvedValue({ data: [] });

    const result = await collectDashboardData();

    expect(result).toHaveProperty('sessions');
    expect(result).toHaveProperty('sessionStatuses');
    expect(result).toHaveProperty('cronJobs');
    expect(result).toHaveProperty('approvals');
    expect(result).toHaveProperty('projects');
    expect(result).toHaveProperty('tasks');
    expect(result).toHaveProperty('projectSummaries');
    expect(result).toHaveProperty('tasksSummary');
    expect(result).toHaveProperty('budgetSummary');
    expect(result).toHaveProperty('diagnostics');
    expect(result).toHaveProperty('sessionsContexts');
    expect(result).toHaveProperty('usageEvents');
  });

  test('has diagnostics.generatedAt timestamp', async () => {
    axios.get.mockResolvedValue({ data: [] });

    const result = await collectDashboardData();

    expect(result.diagnostics).toHaveProperty('generatedAt');
    expect(typeof result.diagnostics.generatedAt).toBe('string');
    expect(new Date(result.diagnostics.generatedAt).toISOString()).toBe(result.diagnostics.generatedAt);
  });

  test('handles API errors gracefully', async () => {
    axios.get.mockRejectedValue(new Error('Network error'));

    const result = await collectDashboardData();

    expect(result.sessions).toEqual([]);
    expect(result.sessionStatuses).toEqual([]);
    expect(result.cronJobs).toEqual([]);
    expect(result.approvals).toEqual([]);
    expect(result.projects).toEqual([]);
    expect(result.tasks).toEqual([]);
    expect(result.projectSummaries).toEqual([]);
    expect(result.tasksSummary).toEqual({});
    expect(result.budgetSummary).toEqual({});
    expect(result.diagnostics).toEqual({ generatedAt: expect.any(String) });
    expect(result.sessionsContexts).toEqual([]);
    expect(result.usageEvents).toEqual([]);
    expect(console.error).toHaveBeenCalled();
  });

  test('fetches data from all endpoints', async () => {
    axios.get.mockImplementation((url) => {
      if (url === 'http://127.0.0.1:4096/api/sessions') return Promise.resolve({ data: [{ id: 's1' }] });
      if (url === 'http://127.0.0.1:4096/api/session-statuses') return Promise.resolve({ data: [{ key: 'st1' }] });
      if (url === 'http://127.0.0.1:4096/api/cron-jobs') return Promise.resolve({ data: [{ id: 'c1' }] });
      if (url === 'http://127.0.0.1:4096/api/approvals') return Promise.resolve({ data: [{ id: 'a1' }] });
      if (url === 'http://127.0.0.1:4096/api/projects') return Promise.resolve({ data: [{ id: 'p1' }] });
      if (url === 'http://127.0.0.1:4096/api/tasks') return Promise.resolve({ data: [{ id: 't1' }] });
      if (url === 'http://127.0.0.1:4096/api/project-summaries') return Promise.resolve({ data: [{ id: 'ps1' }] });
      if (url === 'http://127.0.0.1:4096/api/tasks-summary') return Promise.resolve({ data: { total: 5 } });
      if (url === 'http://127.0.0.1:4096/api/budget-summary') return Promise.resolve({ data: { total: 100 } });
      if (url === 'http://127.0.0.1:4096/api/diagnostics') return Promise.resolve({ data: { status: 'ok' } });
      if (url === 'http://127.0.0.1:4096/api/sessions-contexts') return Promise.resolve({ data: [{ id: 'sc1' }] });
      if (url === 'http://127.0.0.1:4096/api/usage-events') return Promise.resolve({ data: [{ id: 'ue1' }] });
      return Promise.resolve({ data: [] });
    });

    const result = await collectDashboardData();

    expect(result.sessions).toEqual([{ id: 's1' }]);
    expect(result.sessionStatuses).toEqual([{ key: 'st1' }]);
    expect(result.cronJobs).toEqual([{ id: 'c1' }]);
    expect(result.approvals).toEqual([{ id: 'a1' }]);
    expect(result.projects).toEqual([{ id: 'p1' }]);
    expect(result.tasks).toEqual([{ id: 't1' }]);
    expect(result.projectSummaries).toEqual([{ id: 'ps1' }]);
    expect(result.tasksSummary).toEqual({ total: 5 });
    expect(result.budgetSummary).toEqual({ total: 100 });
    expect(result.diagnostics).toEqual({ status: 'ok', generatedAt: expect.any(String) });
    expect(result.sessionsContexts).toEqual([{ id: 'sc1' }]);
    expect(result.usageEvents).toEqual([{ id: 'ue1' }]);
  });

  test('uses empty fallback when response data is null', async () => {
    axios.get.mockResolvedValue({ data: null });

    const result = await collectDashboardData();

    expect(result.sessions).toEqual([]);
    expect(result.tasksSummary).toEqual({});
    expect(result.diagnostics.generatedAt).toBeDefined();
  });

  test('uses correct timeout for each request', async () => {
    axios.get.mockResolvedValue({ data: [] });

    await collectDashboardData();

    expect(axios.get).toHaveBeenCalledWith(
      expect.stringContaining('/api/sessions'),
      expect.objectContaining({ timeout: 5000 })
    );
  });
});
