import { describe, expect, it, vi } from 'vitest'
import { executePluginHostCall, type PluginHostServices } from './plugin-host-methods'

function createServices(storageSet: PluginHostServices['storage']['set']): PluginHostServices {
  return {
    resolveActiveWorktreeContext: vi.fn().mockResolvedValue(null),
    listWorktreeTerminals: vi.fn().mockResolvedValue([]),
    sendTerminalText: vi.fn().mockResolvedValue({ accepted: true }),
    listAgentStatuses: () => [],
    dispatchPluginNotification: vi.fn().mockResolvedValue({ delivered: true }),
    storage: {
      get: vi.fn(),
      set: storageSet,
      delete: vi.fn(),
      keys: vi.fn().mockReturnValue([])
    },
    secrets: {
      get: vi.fn().mockReturnValue({ ok: true, value: null }),
      set: vi.fn().mockReturnValue({ ok: true }),
      delete: vi.fn(),
      protection: vi.fn().mockReturnValue('unavailable')
    },
    settings: {
      getAll: vi.fn().mockReturnValue({}),
      set: vi.fn().mockReturnValue({ ok: true })
    }
  }
}

describe('executePluginHostCall mutation auditing', () => {
  it('fails closed before a mutation when the audit intent cannot be recorded', async () => {
    const storageSet = vi.fn().mockReturnValue({ ok: true })
    const outcome = await executePluginHostCall({
      pluginId: 'samples.demo',
      method: 'storage.set',
      params: { key: 'answer', value: 42 },
      surface: 'worker',
      grantedCapabilities: ['storage:own'],
      services: createServices(storageSet),
      audit: { record: vi.fn().mockRejectedValue(new Error('disk full')) }
    })

    expect(outcome).toMatchObject({ ok: false, code: 'action_failed' })
    expect(storageSet).not.toHaveBeenCalled()
  })
})

describe('workspace.readContext host reachability', () => {
  it('keeps the active remote context when its host cannot list terminals', async () => {
    const services = createServices(vi.fn())
    vi.mocked(services.resolveActiveWorktreeContext).mockResolvedValue({
      worktreeId: 'remote-repo::/home/user/repo',
      branch: '',
      displayName: 'Remote main'
    })
    vi.mocked(services.listWorktreeTerminals).mockRejectedValue(new Error('host_unreachable'))

    const outcome = await executePluginHostCall({
      pluginId: 'samples.demo',
      method: 'workspace.readContext',
      params: {},
      surface: 'panel',
      grantedCapabilities: ['workspace:read'],
      services
    })

    expect(outcome).toMatchObject({
      ok: true,
      value: { branch: '', displayName: 'Remote main', terminals: [] }
    })
  })
})

describe('agents.list for a named workspace', () => {
  it('resolves the workspace through the runtime and lists only its agents', async () => {
    const services = createServices(vi.fn())
    services.runtimeRpc = vi.fn().mockResolvedValue({ worktree: { id: 'wt-1::/repo' } })
    services.listAgentStatuses = () => [
      {
        paneKey: 'tab-1:leaf-1',
        worktreeId: 'wt-1::/repo',
        terminalHandle: 't1',
        state: 'blocked',
        agentType: 'claude',
        stateStartedAt: 10
      },
      {
        paneKey: 'tab-2:leaf-2',
        worktreeId: 'wt-2::/other',
        terminalHandle: 't2',
        state: 'working',
        agentType: 'codex',
        stateStartedAt: 20
      }
    ]
    vi.mocked(services.listWorktreeTerminals).mockResolvedValue([{ id: 't1', title: 'Claude' }])

    const outcome = await executePluginHostCall({
      pluginId: 'samples.demo',
      method: 'agents.list',
      params: { workspaceId: 'identity:wt2:local:abc' },
      surface: 'worker',
      grantedCapabilities: ['agent:read'],
      services
    })

    expect(services.runtimeRpc).toHaveBeenCalledWith(
      'worktree.show',
      { worktree: 'identity:wt2:local:abc', matchFolderWorkspaces: true },
      {}
    )
    expect(services.resolveActiveWorktreeContext).not.toHaveBeenCalled()
    expect(outcome).toMatchObject({
      ok: true,
      value: {
        agents: [
          {
            terminalId: 't1',
            title: 'Claude',
            agent: 'claude',
            state: 'blocked',
            stateStartedAt: 10
          }
        ]
      }
    })
  })
})

describe('terminal.focus', () => {
  it('shows the terminal through the runtime and reports whether the window moved', async () => {
    const services = createServices(vi.fn())
    services.runtimeRpc = vi.fn().mockResolvedValue({
      focus: { handle: 't1', tabId: 'tab-1', worktreeId: 'wt-1::/repo', navigated: true }
    })

    const outcome = await executePluginHostCall({
      pluginId: 'samples.demo',
      method: 'terminal.focus',
      params: { terminalId: 't1' },
      surface: 'worker',
      grantedCapabilities: ['workspace:write'],
      services,
      audit: { record: vi.fn().mockResolvedValue(undefined) }
    })

    expect(services.runtimeRpc).toHaveBeenCalledWith(
      'terminal.focus',
      { terminal: 't1', navigation: 'host' },
      expect.anything()
    )
    expect(outcome).toMatchObject({ ok: true, value: { navigated: true } })
  })
})
