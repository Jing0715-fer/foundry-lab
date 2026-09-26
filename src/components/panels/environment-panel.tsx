"use client";

import * as React from "react";
import { useAppStore } from "@/lib/store";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  CheckCircle2,
  XCircle,
  Download,
  ExternalLink,
  RefreshCw,
  Terminal,
  Loader2,
} from "lucide-react";

interface ScanResult {
  key: string;
  label: string;
  installed: boolean;
  installCommand: string;
  installMethod: string;
  docs: string;
  category: string;
}

const CATEGORY_ORDER = [
  "design",
  "inverse-folding",
  "structure-prediction",
  "scoring",
  "bio",
];

/**
 * Environment Management panel.
 *
 * Scans the host for installed comp tools (via GET /api/tools/scan — created
 * by Task 20-a). Lists every tool grouped by category with a clear
 * "Installed / Missing" badge. Missing tools show the install command + a
 * one-click "Copy install command" button (real install requires terminal
 * access, so we copy the command for the user to run in their own shell).
 *
 * If the scan endpoint is unavailable (e.g. Task 20-a hasn't shipped yet),
 * the panel shows a friendly error message + a Rescan button.
 */
export function EnvironmentPanel() {
  const toast = useAppStore((s) => s.toast);
  const [tools, setTools] = React.useState<ScanResult[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [scanning, setScanning] = React.useState(false);
  const [installing, setInstalling] = React.useState<string | null>(null);
  const [scanError, setScanError] = React.useState<string | null>(null);

  const scan = React.useCallback(async () => {
    setScanning(true);
    setScanError(null);
    try {
      const res = await fetch("/api/tools/scan");
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = await res.json();
      setTools(Array.isArray(data.tools) ? data.tools : []);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Unknown error";
      setScanError(msg);
      toast({ title: "Scan failed", description: msg, variant: "destructive" });
    } finally {
      setScanning(false);
      setLoading(false);
    }
  }, [toast]);

  React.useEffect(() => {
    void scan();
  }, [scan]);

  const install = async (tool: ScanResult) => {
    setInstalling(tool.key);
    toast({
      title: `Install ${tool.label}`,
      description: `Run: ${tool.installCommand}`,
    });
    // Copy to clipboard so the user can paste into their terminal.
    try {
      await navigator.clipboard.writeText(tool.installCommand);
      toast({ title: "Command copied to clipboard", variant: "success" });
    } catch {
      // Clipboard may be unavailable (SSR, insecure context) — non-fatal.
      toast({
        title: "Could not copy",
        description: "Copy the command from the card manually.",
        variant: "destructive",
      });
    }
    setTimeout(() => setInstalling(null), 1500);
  };

  const installedCount = tools.filter((t) => t.installed).length;

  return (
    <div className="flex h-full flex-col overflow-y-auto p-4 md:p-6">
      <div className="mx-auto w-full max-w-4xl space-y-6">
        {/* Header + Rescan */}
        <div className="flex items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Environment</h1>
            <p className="text-sm text-muted-foreground">
              {loading
                ? "Scanning for installed tools…"
                : `${installedCount} of ${tools.length} tools installed`}
            </p>
          </div>
          <Button onClick={scan} disabled={scanning} variant="outline">
            {scanning ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <RefreshCw className="size-4" />
            )}
            Rescan
          </Button>
        </div>

        {/* Summary cards */}
        <div className="grid gap-3 sm:grid-cols-3">
          <Card>
            <CardContent className="p-4">
              <div className="text-2xl font-bold text-emerald-600">
                {installedCount}
              </div>
              <div className="text-xs text-muted-foreground">Installed</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="text-2xl font-bold text-rose-600">
                {tools.length - installedCount}
              </div>
              <div className="text-xs text-muted-foreground">Missing</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="text-2xl font-bold">{tools.length}</div>
              <div className="text-xs text-muted-foreground">Total Tools</div>
            </CardContent>
          </Card>
        </div>

        {/* Tool list grouped by category */}
        {loading ? (
          <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed bg-muted/30 p-12 text-center text-sm text-muted-foreground">
            <Loader2 className="size-6 animate-spin" />
            Scanning for installed tools…
          </div>
        ) : scanError ? (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-6 text-sm">
            <p className="mb-2 font-medium text-amber-700 dark:text-amber-400">
              Scan endpoint unavailable
            </p>
            <p className="text-xs text-muted-foreground">
              The <code className="font-mono">/api/tools/scan</code> endpoint
              returned an error ({scanError}). It may not be provisioned yet
              (Task 20-a). Click <strong>Rescan</strong> to retry.
            </p>
          </div>
        ) : (
          CATEGORY_ORDER.map((cat) => {
            const catTools = tools.filter((t) => t.category === cat);
            if (catTools.length === 0) return null;
            return (
              <div key={cat} className="space-y-3">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                  {cat.replace(/-/g, " ")}
                </h2>
                <div className="grid gap-3 sm:grid-cols-2">
                  {catTools.map((tool) => (
                    <Card
                      key={tool.key}
                      className={
                        tool.installed ? "border-emerald-500/30" : ""
                      }
                    >
                      <CardHeader className="pb-3">
                        <div className="flex items-center justify-between gap-2">
                          <CardTitle className="text-base">
                            {tool.label}
                          </CardTitle>
                          {tool.installed ? (
                            <Badge className="bg-emerald-500/10 text-emerald-600">
                              <CheckCircle2 className="mr-1 size-3" /> Installed
                            </Badge>
                          ) : (
                            <Badge
                              variant="secondary"
                              className="bg-rose-500/10 text-rose-600"
                            >
                              <XCircle className="mr-1 size-3" /> Missing
                            </Badge>
                          )}
                        </div>
                        <p className="text-[10px] font-mono uppercase text-muted-foreground">
                          {tool.key} · {tool.installMethod}
                        </p>
                      </CardHeader>
                      <CardContent>
                        {!tool.installed && (
                          <div className="space-y-2">
                            <div className="rounded-md bg-muted p-2">
                              <code className="block break-all font-mono text-xs">
                                {tool.installCommand}
                              </code>
                            </div>
                            <div className="flex flex-wrap gap-2">
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => install(tool)}
                                disabled={installing === tool.key}
                              >
                                {installing === tool.key ? (
                                  <Loader2 className="size-3.5 animate-spin" />
                                ) : (
                                  <Terminal className="size-3.5" />
                                )}
                                {installing === tool.key
                                  ? "Copying…"
                                  : "Copy install command"}
                              </Button>
                              <Button size="sm" variant="ghost" asChild>
                                <a
                                  href={tool.docs}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                >
                                  <ExternalLink className="size-3.5" /> Docs
                                </a>
                              </Button>
                            </div>
                          </div>
                        )}
                        {tool.installed && (
                          <div className="flex items-center gap-2 text-xs text-muted-foreground">
                            <Download className="size-3.5 text-emerald-600" />
                            Ready to use. Will run with real algorithms.
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

export default EnvironmentPanel;
