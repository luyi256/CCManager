import { useState, useEffect } from 'react';
import { getDeviceTokens, createDeviceToken, revokeDeviceToken, getCurrentDevice, getAgents, registerAgent, generateAgentToken, getAgentTokenInfo, revokeAgentToken } from '../services/api';
import type { DeviceInfo, AgentTokenInfo } from '../services/api';
import type { Agent } from '../types';
import { clearApiToken } from '../services/auth';
import { Trash2, Monitor, Plus, RefreshCw, Copy, Check, Server } from 'lucide-react';

export default function SettingsPage() {
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [revoking, setRevoking] = useState<number | null>(null);
  const [currentDeviceId, setCurrentDeviceId] = useState<number | null>(null);

  // Device creation state
  const [newDeviceName, setNewDeviceName] = useState('');
  const [creatingDevice, setCreatingDevice] = useState(false);
  const [shownDeviceToken, setShownDeviceToken] = useState<{ name: string; token: string } | null>(null);
  const [deviceTokenCopied, setDeviceTokenCopied] = useState(false);

  // Agent management state
  const [agents, setAgents] = useState<Agent[]>([]);
  const [agentTokens, setAgentTokens] = useState<Record<string, AgentTokenInfo>>({});
  const [agentsLoading, setAgentsLoading] = useState(true);
  const [newAgentId, setNewAgentId] = useState('');
  const [newAgentName, setNewAgentName] = useState('');
  const [registering, setRegistering] = useState(false);
  const [generatingToken, setGeneratingToken] = useState<string | null>(null);
  const [revokingAgent, setRevokingAgent] = useState<string | null>(null);
  const [shownToken, setShownToken] = useState<{ agentId: string; token: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const fetchDevices = async () => {
    try {
      const data = await getDeviceTokens();
      setDevices(data);
    } catch (err) {
      console.error('Failed to fetch devices:', err);
    } finally {
      setLoading(false);
    }
  };

  const fetchCurrentDevice = async () => {
    try {
      const me = await getCurrentDevice();
      setCurrentDeviceId(me.id);
    } catch (err) {
      console.error('Failed to fetch current device:', err);
    }
  };

  const fetchAgents = async () => {
    try {
      const agentList = await getAgents();
      setAgents(agentList);
      // Fetch token info for each agent
      const tokenInfos: Record<string, AgentTokenInfo> = {};
      for (const agent of agentList) {
        try {
          tokenInfos[agent.id] = await getAgentTokenInfo(agent.id);
        } catch { /* ignore */ }
      }
      setAgentTokens(tokenInfos);
    } catch (err) {
      console.error('Failed to fetch agents:', err);
    } finally {
      setAgentsLoading(false);
    }
  };

  useEffect(() => {
    fetchDevices();
    fetchCurrentDevice();
    fetchAgents();
  }, []);

  const handleCreateDevice = async () => {
    if (!newDeviceName.trim()) return;
    setCreatingDevice(true);
    try {
      const result = await createDeviceToken(newDeviceName.trim());
      setShownDeviceToken({ name: result.name, token: result.token });
      setNewDeviceName('');
      await fetchDevices();
    } catch (err) {
      console.error('Failed to create device token:', err);
      alert('创建失败: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setCreatingDevice(false);
    }
  };

  const handleCopyDeviceToken = async (token: string) => {
    try {
      await navigator.clipboard.writeText(token);
      setDeviceTokenCopied(true);
      setTimeout(() => setDeviceTokenCopied(false), 2000);
    } catch { /* ignore */ }
  };

  const handleRevoke = async (id: number) => {
    if (id === currentDeviceId) {
      if (!confirm('确定要吊销当前设备的 token 吗？你将被登出。')) return;
    } else {
      if (!confirm('确定要吊销该设备的 token 吗？该设备将立即失效。')) return;
    }

    setRevoking(id);
    try {
      await revokeDeviceToken(id);
      if (id === currentDeviceId) {
        clearApiToken();
        window.location.reload();
        return;
      }
      setDevices((prev) => prev.filter((d) => d.id !== id));
    } catch (err) {
      console.error('Failed to revoke device:', err);
    } finally {
      setRevoking(null);
    }
  };

  const handleRegisterAgent = async () => {
    if (!newAgentId.trim()) return;
    if (!/^[a-zA-Z0-9_-]+$/.test(newAgentId.trim())) {
      alert('Agent ID 只能包含字母、数字、连字符和下划线');
      return;
    }
    setRegistering(true);
    try {
      const result = await registerAgent(newAgentId.trim(), newAgentName.trim() || undefined);
      setShownToken({ agentId: result.agentId, token: result.token });
      setNewAgentId('');
      setNewAgentName('');
      await fetchAgents();
    } catch (err) {
      console.error('Failed to register agent:', err);
      alert('注册失败: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setRegistering(false);
    }
  };

  const handleGenerateToken = async (agentId: string) => {
    if (!confirm(`确定要为 ${agentId} 重新生成 token 吗？旧 token 将立即失效。`)) return;
    setGeneratingToken(agentId);
    try {
      const result = await generateAgentToken(agentId);
      setShownToken({ agentId: result.agentId, token: result.token });
      await fetchAgents();
    } catch (err) {
      console.error('Failed to generate agent token:', err);
    } finally {
      setGeneratingToken(null);
    }
  };

  const handleRevokeAgentToken = async (agentId: string) => {
    if (!confirm(`确定要吊销 ${agentId} 的 token 吗？该 agent 将无法连接。`)) return;
    setRevokingAgent(agentId);
    try {
      await revokeAgentToken(agentId);
      await fetchAgents();
      if (shownToken?.agentId === agentId) setShownToken(null);
    } catch (err) {
      console.error('Failed to revoke agent token:', err);
    } finally {
      setRevokingAgent(null);
    }
  };

  const handleCopyToken = async (token: string) => {
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* ignore */ }
  };

  const formatTime = (iso: string | null | undefined) => {
    if (!iso) return '-';
    const d = new Date(iso + 'Z');
    return d.toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  return (
    <div className="max-w-3xl mx-auto px-4 py-8 space-y-10">
      {/* Device Management */}
      <section>
        <h1 className="text-2xl font-semibold text-dark-100 mb-6">设备管理</h1>

        {/* Create new device token */}
        <div className="mb-6 p-4 rounded-lg border border-dark-700 bg-dark-800">
          <h3 className="text-sm font-medium text-dark-300 mb-3">创建新设备 Token</h3>
          <div className="flex gap-3">
            <input
              type="text"
              value={newDeviceName}
              onChange={(e) => setNewDeviceName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleCreateDevice()}
              placeholder="设备名称 (如 MacBook Pro)"
              className="flex-1 px-3 py-2 bg-dark-900 border border-dark-600 rounded text-dark-100 placeholder-dark-500 text-sm"
              maxLength={64}
            />
            <button
              onClick={handleCreateDevice}
              disabled={creatingDevice || !newDeviceName.trim()}
              className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded text-sm transition-colors"
            >
              <Plus size={16} />
              创建
            </button>
          </div>
        </div>

        {/* Show generated device token */}
        {shownDeviceToken && (
          <div className="mb-6 p-4 rounded-lg border border-yellow-500/40 bg-yellow-500/5">
            <p className="text-yellow-400 text-sm font-medium mb-2">
              设备「{shownDeviceToken.name}」的 Token（仅显示一次，请立即复制）：
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 px-3 py-2 bg-dark-900 rounded text-green-400 text-sm font-mono break-all">
                {shownDeviceToken.token}
              </code>
              <button
                onClick={() => handleCopyDeviceToken(shownDeviceToken.token)}
                className="p-2 text-dark-400 hover:text-dark-100 transition-colors"
                title="复制"
              >
                {deviceTokenCopied ? <Check size={18} className="text-green-400" /> : <Copy size={18} />}
              </button>
            </div>
            <p className="text-dark-500 text-xs mt-2">
              使用此 Token 在新设备的浏览器中登录
            </p>
          </div>
        )}

        {loading ? (
          <p className="text-dark-400">加载中...</p>
        ) : devices.length === 0 ? (
          <p className="text-dark-400">暂无已注册设备</p>
        ) : (
          <div className="space-y-3">
            {devices.map((device) => {
              const isCurrent = device.id === currentDeviceId;
              return (
                <div
                  key={device.id}
                  className={`flex items-center justify-between p-4 rounded-lg border ${
                    isCurrent
                      ? 'border-blue-500/40 bg-blue-500/5'
                      : 'border-dark-700 bg-dark-800'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <div className="text-dark-400">
                      <Monitor size={20} />
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-dark-100 font-medium">{device.name}</span>
                        {isCurrent && (
                          <span className="text-xs px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-400">
                            当前设备
                          </span>
                        )}
                      </div>
                      <div className="text-sm text-dark-400 mt-0.5">
                        注册: {formatTime(device.createdAt)}
                        {device.lastUsedAt && (
                          <span className="ml-3">最近活跃: {formatTime(device.lastUsedAt)}</span>
                        )}
                      </div>
                    </div>
                  </div>

                  <button
                    onClick={() => handleRevoke(device.id)}
                    disabled={revoking === device.id}
                    className="p-2 text-dark-400 hover:text-red-400 transition-colors disabled:opacity-50"
                    title="吊销"
                  >
                    <Trash2 size={18} />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Agent Token Management */}
      <section>
        <h2 className="text-2xl font-semibold text-dark-100 mb-6">Agent 管理</h2>

        {/* Register new agent */}
        <div className="mb-6 p-4 rounded-lg border border-dark-700 bg-dark-800">
          <h3 className="text-sm font-medium text-dark-300 mb-3">注册新 Agent</h3>
          <div className="flex gap-3">
            <input
              type="text"
              value={newAgentId}
              onChange={(e) => setNewAgentId(e.target.value)}
              placeholder="Agent ID (如 macbook-agent)"
              className="flex-1 px-3 py-2 bg-dark-900 border border-dark-600 rounded text-dark-100 placeholder-dark-500 text-sm"
            />
            <input
              type="text"
              value={newAgentName}
              onChange={(e) => setNewAgentName(e.target.value)}
              placeholder="名称 (可选)"
              className="flex-1 px-3 py-2 bg-dark-900 border border-dark-600 rounded text-dark-100 placeholder-dark-500 text-sm"
            />
            <button
              onClick={handleRegisterAgent}
              disabled={registering || !newAgentId.trim()}
              className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded text-sm transition-colors"
            >
              <Plus size={16} />
              注册
            </button>
          </div>
        </div>

        {/* Show generated token */}
        {shownToken && (
          <div className="mb-6 p-4 rounded-lg border border-yellow-500/40 bg-yellow-500/5">
            <p className="text-yellow-400 text-sm font-medium mb-2">
              Agent「{shownToken.agentId}」的 Token（仅显示一次，请立即复制）：
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 px-3 py-2 bg-dark-900 rounded text-green-400 text-sm font-mono break-all">
                {shownToken.token}
              </code>
              <button
                onClick={() => handleCopyToken(shownToken.token)}
                className="p-2 text-dark-400 hover:text-dark-100 transition-colors"
                title="复制"
              >
                {copied ? <Check size={18} className="text-green-400" /> : <Copy size={18} />}
              </button>
            </div>
            <p className="text-dark-500 text-xs mt-2">
              将此 token 填入 agent 配置文件的 authToken 字段
            </p>
          </div>
        )}

        {/* Agent list */}
        {agentsLoading ? (
          <p className="text-dark-400">加载中...</p>
        ) : agents.length === 0 ? (
          <p className="text-dark-400">暂无已注册 Agent</p>
        ) : (
          <div className="space-y-3">
            {agents.map((agent) => {
              const tokenInfo = agentTokens[agent.id];
              return (
                <div
                  key={agent.id}
                  className="flex items-center justify-between p-4 rounded-lg border border-dark-700 bg-dark-800"
                >
                  <div className="flex items-center gap-3">
                    <div className="text-dark-400">
                      <Server size={20} />
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-dark-100 font-medium">{agent.name}</span>
                        <span className="text-xs text-dark-500 font-mono">{agent.id}</span>
                        <span className={`text-xs px-1.5 py-0.5 rounded ${
                          agent.status === 'online'
                            ? 'bg-green-500/20 text-green-400'
                            : agent.status === 'busy'
                              ? 'bg-yellow-500/20 text-yellow-400'
                              : 'bg-dark-600 text-dark-400'
                        }`}>
                          {agent.status}
                        </span>
                      </div>
                      <div className="text-sm text-dark-400 mt-0.5">
                        {tokenInfo?.hasToken ? (
                          <>
                            Token 创建: {formatTime(tokenInfo.createdAt)}
                            {tokenInfo.lastUsedAt && (
                              <span className="ml-3">最近使用: {formatTime(tokenInfo.lastUsedAt)}</span>
                            )}
                          </>
                        ) : (
                          <span className="text-yellow-500">未配置 Token</span>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => handleGenerateToken(agent.id)}
                      disabled={generatingToken === agent.id}
                      className="flex items-center gap-1 px-3 py-1.5 text-sm text-dark-300 hover:text-dark-100 border border-dark-600 hover:border-dark-500 rounded transition-colors disabled:opacity-50"
                      title={tokenInfo?.hasToken ? '重新生成 Token' : '生成 Token'}
                    >
                      <RefreshCw size={14} />
                      {tokenInfo?.hasToken ? '重新生成' : '生成'}
                    </button>
                    {tokenInfo?.hasToken && (
                      <button
                        onClick={() => handleRevokeAgentToken(agent.id)}
                        disabled={revokingAgent === agent.id}
                        className="p-2 text-dark-400 hover:text-red-400 transition-colors disabled:opacity-50"
                        title="吊销 Token"
                      >
                        <Trash2 size={18} />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
