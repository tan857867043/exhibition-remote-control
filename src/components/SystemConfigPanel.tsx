import React, { useState } from "react";
import { Settings, Monitor, Network, RefreshCw, Save, X, CheckCircle2, XCircle, Loader2 } from "lucide-react";
import { confirmDialog } from "../lib/ui";

interface SystemConfigPanelProps {
  device: { id: string; name: string; online: boolean };
  serverUrl: string;
  onClose: () => void;
}

export function SystemConfigPanel({ device, serverUrl, onClose }: SystemConfigPanelProps) {
  const [activeTab, setActiveTab] = useState<"computer" | "network">("computer");

  // ── Computer name ──
  const [computerName, setComputerName] = useState(device.name);
  const [nameLoading, setNameLoading] = useState(false);
  const [nameResult, setNameResult] = useState<{ type: "success" | "error"; message: string } | null>(null);

  // ── Network config ──
  const [interfaces, setInterfaces] = useState<any[]>([]);
  const [selectedInterfaceIndex, setSelectedInterfaceIndex] = useState<number>(0);
  const [ip, setIp] = useState("");
  const [mask, setMask] = useState("");
  const [gateway, setGateway] = useState("");
  const [dns, setDns] = useState("");
  const [netLoading, setNetLoading] = useState(false);
  const [netFetching, setNetFetching] = useState(false);
  const [netResult, setNetResult] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [ipConflict, setIpConflict] = useState<{ checking: boolean; inUse: boolean; message: string } | null>(null);

  const apiBase = serverUrl;

  // ── Rename computer ──
  const handleRenameComputer = async () => {
    if (!computerName.trim()) return;
    setNameLoading(true);
    setNameResult(null);
    try {
      const res = await fetch(`${apiBase}/api/v1/devices/system-config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          device_id: device.id,
          action: "rename_computer",
          name: computerName.trim()
        })
      });
      const data = await res.json();
      if (data.success) {
        setNameResult({ type: "success", message: "计算机名修改成功，重启后生效" });
      } else {
        setNameResult({ type: "error", message: data.error || "修改失败" });
      }
    } catch (e: any) {
      setNameResult({ type: "error", message: e.message || "请求失败" });
    } finally {
      setNameLoading(false);
    }
  };

  // ── Fetch network config ──
  const handleFetchNetConfig = async () => {
    setNetFetching(true);
    setNetResult(null);
    try {
      const res = await fetch(`${apiBase}/api/v1/devices/system-config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          device_id: device.id,
          action: "get_ip_config"
        })
      });
      const data = await res.json();
      if (data.success && data.data) {
        const list = data.data.interfaces || [];
        setInterfaces(list);
        // 自动回填时优先选"有 IPv4 且有网关"的活动网卡（多网卡机器上 list[0] 可能是
        // 已断开的物理网卡或漏过滤的 VPN 网卡，导致自动填入空值或错误配置）
        const activeIdx = list.findIndex((it: any) => it.ipv4 && it.gateway);
        const fallbackIdx = list.findIndex((it: any) => it.ipv4);
        const idx = activeIdx >= 0 ? activeIdx : fallbackIdx >= 0 ? fallbackIdx : 0;
        setSelectedInterfaceIndex(idx);
        if (list.length > 0) {
          const sel = list[idx] || list[0];
          setIp(sel.ipv4 || "");
          setMask(sel.mask || "");
          setGateway(sel.gateway || "");
          setDns(sel.dns || "");
        }
        // 保存完整响应数据用于调试
        setNetResult({ type: "success", message: JSON.stringify(data.data, null, 2) });
      } else {
        setNetResult({ type: "error", message: data.error || "获取配置失败" });
      }
    } catch (e: any) {
      setNetResult({ type: "error", message: e.message || "请求失败" });
    } finally {
      setNetFetching(false);
    }
  };

  const handleInterfaceChange = (idx: number) => {
    setSelectedInterfaceIndex(idx);
    const iface = interfaces[idx];
    if (iface) {
      setIp(iface.ipv4 || "");
      setMask(iface.mask || "");
      setGateway(iface.gateway || "");
      setDns(iface.dns || "");
    }
  };

  // ── Check IP usage (conflict detection) ──
  const handleCheckIpUsage = async (): Promise<boolean> => {
    if (!ip) return false;
    setIpConflict({ checking: true, inUse: false, message: "正在检测 IP 是否被占用..." });
    try {
      const res = await fetch(`${apiBase}/api/v1/devices/system-config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          device_id: device.id,
          action: "check_ip_usage",
          ip: ip.trim()
        })
      });
      const data = await res.json();
      if (data.success && data.data) {
        const inUse = data.data.in_use === true;
        setIpConflict({
          checking: false,
          inUse,
          message: data.data.message || (inUse ? "IP 可能已被占用" : "IP 未被检测到使用中")
        });
        return inUse;
      }
      setIpConflict({ checking: false, inUse: false, message: "检测失败，将直接尝试设置" });
      return false;
    } catch {
      setIpConflict({ checking: false, inUse: false, message: "检测请求失败，将直接尝试设置" });
      return false;
    }
  };

  // ── Set IP config ──
  const handleSetIp = async () => {
    const selectedIface = interfaces[selectedInterfaceIndex];
    if (!selectedIface || !ip) return;

    // Step 1: Check IP conflict first
    const conflictDetected = await handleCheckIpUsage();
    if (conflictDetected) {
      const proceed = await confirmDialog(
        `⚠ 检测到 IP 地址 ${ip} 可能已被同一局域网内的其他设备使用。\n\n继续设置可能导致 IP 冲突和网络中断。\n\n是否仍然继续？`
      );
      if (!proceed) {
        setIpConflict({ checking: false, inUse: true, message: `已取消设置，IP ${ip} 可能存在冲突` });
        return;
      }
    }

    // Step 2: Apply IP config
    setNetLoading(true);
    setNetResult(null);
    try {
      const body: any = {
        device_id: device.id,
        action: "set_ip",
        interface: selectedIface.name || "",
        ip,
        mask,
        gateway
      };
      if (dns.trim()) {
        body.dns = dns.split(",").map(s => s.trim()).filter(Boolean);
      }
      const res = await fetch(`${apiBase}/api/v1/devices/system-config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const data = await res.json();
      if (data.success) {
        setNetResult({ type: "success", message: "IP 配置已应用" });
        setIpConflict(null);
      } else {
        setNetResult({ type: "error", message: data.error || "设置失败" });
      }
    } catch (e: any) {
      setNetResult({ type: "error", message: e.message || "请求失败" });
    } finally {
      setNetLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-md p-4">
      <div className="bg-card border border-border w-full max-w-2xl rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* ── Header ── */}
        <div className="px-6 py-4 bg-card border-b border-border flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2.5 bg-primary/10 border border-primary/20 text-primary rounded-xl">
              <Settings className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-bold text-foreground flex items-center gap-2">
                系统配置
                <span className="text-xs font-medium px-2 py-0.5 bg-primary/10 text-primary border border-primary/20 rounded-full">
                  {device.name}
                </span>
              </h3>
              <p className="text-xs text-muted-foreground">修改计算机名与网络配置</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 text-muted-foreground hover:text-foreground hover:bg-muted rounded-lg transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* ── Tabs ── */}
        <div className="flex border-b border-border">
          <button
            onClick={() => setActiveTab("computer")}
            className={`flex items-center gap-2 px-5 py-3 text-xs font-medium transition-colors border-b-2 ${
              activeTab === "computer"
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            <Monitor className="w-4 h-4" />
            计算机名
          </button>
          <button
            onClick={() => setActiveTab("network")}
            className={`flex items-center gap-2 px-5 py-3 text-xs font-medium transition-colors border-b-2 ${
              activeTab === "network"
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            <Network className="w-4 h-4" />
            网络配置
          </button>
        </div>

        {/* ── Content ── */}
        <div className="flex-1 overflow-y-auto p-6 space-y-5">
          {activeTab === "computer" && (
            <div className="space-y-4">
              <div className="flex flex-col gap-1.5">
                <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">计算机名</label>
                <input
                  type="text"
                  value={computerName}
                  onChange={(e) => setComputerName(e.target.value)}
                  placeholder="输入新的计算机名"
                  className="w-full px-3 py-2 text-sm rounded-md border bg-background text-foreground border-border focus:outline-none focus:border-primary/50 transition-colors font-mono"
                />
                <p className="text-[10px] text-muted-foreground">修改后需重启设备方可生效</p>
              </div>

              <button
                onClick={handleRenameComputer}
                disabled={nameLoading || !computerName.trim()}
                className="flex items-center gap-1.5 px-4 py-2 rounded-md text-xs font-medium transition-all disabled:opacity-50"
                style={{
                  background: "var(--ur-primary-600)",
                  color: "#fff",
                  cursor: nameLoading || !computerName.trim() ? "not-allowed" : "pointer"
                }}
              >
                {nameLoading ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Save className="w-3.5 h-3.5" />
                )}
                {nameLoading ? "保存中..." : "保存修改"}
              </button>

              {nameResult && (
                <div
                  className="flex items-center gap-2 px-3 py-2 rounded-md text-xs"
                  style={{
                    background: nameResult.type === "success" ? "var(--ur-state-success-bg)" : "var(--ur-state-error-bg)",
                    color: nameResult.type === "success" ? "var(--ur-state-success-foreground)" : "var(--ur-state-error-foreground)",
                    border: `1px solid ${
                      nameResult.type === "success" ? "var(--ur-state-success)" : "var(--ur-state-error)"
                    }`
                  }}
                >
                  {nameResult.type === "success" ? (
                    <CheckCircle2 className="w-4 h-4 flex-shrink-0" style={{ color: "var(--ur-state-success)" }} />
                  ) : (
                    <XCircle className="w-4 h-4 flex-shrink-0" style={{ color: "var(--ur-state-error)" }} />
                  )}
                  <span>{nameResult.message}</span>
                </div>
              )}
            </div>
          )}

          {activeTab === "network" && (
            <div className="space-y-4">
              {/* Fetch button */}
              <button
                onClick={handleFetchNetConfig}
                disabled={netFetching}
                className="flex items-center gap-1.5 px-4 py-2 rounded-md text-xs font-medium transition-all disabled:opacity-50"
                style={{
                  background: "var(--ur-primary-600)",
                  color: "#fff",
                  cursor: netFetching ? "not-allowed" : "pointer"
                }}
              >
                {netFetching ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="w-3.5 h-3.5" />
                )}
                {netFetching ? "获取中..." : "获取当前网络配置"}
              </button>

              {interfaces.length > 0 && (
                <>
                  {/* Interface selector */}
                  <div className="flex flex-col gap-1.5">
                    <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">网络接口</label>
                    <select
                      value={selectedInterfaceIndex}
                      onChange={(e) => handleInterfaceChange(Number(e.target.value))}
                      className="w-full px-3 py-2 text-sm rounded-md border bg-background text-foreground border-border focus:outline-none focus:border-primary/50 transition-colors"
                    >
                      {interfaces.map((iface: any, i: number) => (
                        <option key={i} value={i}>
                          {iface.name || `接口 ${i + 1}`}
                        </option>
                      ))}
                    </select>
                  </div>

                  {/* IP address */}
                  <div className="flex flex-col gap-1.5">
                    <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">IP 地址</label>
                    <input
                      type="text"
                      value={ip}
                      onChange={(e) => setIp(e.target.value)}
                      placeholder="192.168.1.100"
                      className="w-full px-3 py-2 text-sm rounded-md border bg-background text-foreground border-border focus:outline-none focus:border-primary/50 transition-colors font-mono"
                    />
                  </div>

                  {/* Subnet mask */}
                  <div className="flex flex-col gap-1.5">
                    <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">子网掩码</label>
                    <input
                      type="text"
                      value={mask}
                      onChange={(e) => setMask(e.target.value)}
                      placeholder="255.255.255.0"
                      className="w-full px-3 py-2 text-sm rounded-md border bg-background text-foreground border-border focus:outline-none focus:border-primary/50 transition-colors font-mono"
                    />
                  </div>

                  {/* Gateway */}
                  <div className="flex flex-col gap-1.5">
                    <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">默认网关</label>
                    <input
                      type="text"
                      value={gateway}
                      onChange={(e) => setGateway(e.target.value)}
                      placeholder="192.168.1.1"
                      className="w-full px-3 py-2 text-sm rounded-md border bg-background text-foreground border-border focus:outline-none focus:border-primary/50 transition-colors font-mono"
                    />
                  </div>

                  {/* DNS */}
                  <div className="flex flex-col gap-1.5">
                    <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">DNS 服务器（逗号分隔）</label>
                    <input
                      type="text"
                      value={dns}
                      onChange={(e) => setDns(e.target.value)}
                      placeholder="8.8.8.8, 8.8.4.4"
                      className="w-full px-3 py-2 text-sm rounded-md border bg-background text-foreground border-border focus:outline-none focus:border-primary/50 transition-colors font-mono"
                    />
                  </div>

                  {/* IP conflict warning */}
                  {ipConflict && !ipConflict.checking && (
                    <div
                      className="flex items-center gap-2 px-3 py-2 rounded-md text-xs"
                      style={{
                        background: ipConflict.inUse ? "rgba(239,68,68,0.1)" : "rgba(16,185,129,0.1)",
                        color: ipConflict.inUse ? "rgb(239,68,68)" : "rgb(16,185,129)",
                        border: `1px solid ${ipConflict.inUse ? "rgba(239,68,68,0.3)" : "rgba(16,185,129,0.3)"}`
                      }}
                    >
                      {ipConflict.inUse ? <XCircle className="w-4 h-4 flex-shrink-0" /> : <CheckCircle2 className="w-4 h-4 flex-shrink-0" />}
                      <span>{ipConflict.message}</span>
                    </div>
                  )}

                  {/* Apply button */}
                  <button
                    onClick={handleSetIp}
                    disabled={netLoading || !ip || !interfaces[selectedInterfaceIndex]}
                    className="flex items-center gap-1.5 px-4 py-2 rounded-md text-xs font-medium transition-all disabled:opacity-50"
                    style={{
                      background: "var(--ur-primary-600)",
                      color: "#fff",
                      cursor: netLoading || !ip || !interfaces[selectedInterfaceIndex] ? "not-allowed" : "pointer"
                    }}
                  >
                    {netLoading ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Save className="w-3.5 h-3.5" />
                    )}
                    {netLoading ? "应用中..." : "应用配置"}
                  </button>

                  {/* Debug: Show raw data */}
                  {netResult && (
                    <details className="mt-2">
                      <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground transition-colors">
                        查看获取的原始数据
                      </summary>
                      <pre className="mt-2 p-3 rounded-md text-xs font-mono bg-muted border border-border overflow-auto max-h-64 whitespace-pre-wrap">
                        {JSON.stringify(JSON.parse(netResult.message), null, 2)}
                      </pre>
                    </details>
                  )}
                </>
              )}

              {netResult && (
                <div
                  className="flex items-center gap-2 px-3 py-2 rounded-md text-xs"
                  style={{
                    background: netResult.type === "success" ? "var(--ur-state-success-bg)" : "var(--ur-state-error-bg)",
                    color: netResult.type === "success" ? "var(--ur-state-success-foreground)" : "var(--ur-state-error-foreground)",
                    border: `1px solid ${
                      netResult.type === "success" ? "var(--ur-state-success)" : "var(--ur-state-error)"
                    }`
                  }}
                >
                  {netResult.type === "success" ? (
                    <CheckCircle2 className="w-4 h-4 flex-shrink-0" style={{ color: "var(--ur-state-success)" }} />
                  ) : (
                    <XCircle className="w-4 h-4 flex-shrink-0" style={{ color: "var(--ur-state-error)" }} />
                  )}
                  <span>{netResult.message}</span>
                </div>
              )}

              {interfaces.length === 0 && !netFetching && !netResult && (
                <p className="text-xs text-muted-foreground text-center py-8">
                  点击上方按钮获取当前设备的网络配置
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}