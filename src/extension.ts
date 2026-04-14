import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { execSync, exec } from 'child_process';

let dashboardPanel: vscode.WebviewPanel | undefined;

// ─── Activation ──────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext) {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) return;
  if (!fs.existsSync(path.join(workspaceRoot, '.tabulakit'))) return;

  const previewPort = ensurePreviewPort(workspaceRoot);
  const siteConfig = readSiteConfig(workspaceRoot);

  context.subscriptions.push(
    vscode.commands.registerCommand('tabulakit.showDashboard', () => {
      showDashboard(context, workspaceRoot, siteConfig, previewPort);
    }),
    vscode.commands.registerCommand('tabulakit.refreshPreview', () => {
      dashboardPanel?.webview.postMessage({ command: 'refreshPreview' });
    }),
    vscode.commands.registerCommand('tabulakit.resetLayout', async () => {
      applyTabulaKitLayout();
      // Close only the dashboard (not Claude Code or other tabs), then reopen fresh
      if (dashboardPanel) {
        dashboardPanel.dispose();
        dashboardPanel = undefined;
      }
      // Even out editor widths and reset panel sizes
      await vscode.commands.executeCommand('workbench.action.evenEditorWidths').catch(() => {});
      // Reopen dashboard
      showDashboard(context, workspaceRoot, siteConfig, previewPort);
    }),
    vscode.commands.registerCommand('tabulakit.checkForUpdates', () => {
      checkForUpdates(workspaceRoot);
    }),
    vscode.commands.registerCommand('tabulakit.startPreview', () => {
      startPreviewServer(workspaceRoot, previewPort);
    })
  );

  // Sidebar welcome panel
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('tabulakit.welcome',
      new WelcomeViewProvider(siteConfig))
  );

  applyTabulaKitLayout();
  showDashboard(context, workspaceRoot, siteConfig, previewPort);
  startPreviewServer(workspaceRoot, previewPort);

  // Even out panel widths after a short delay (gives panels time to open)
  setTimeout(() => {
    vscode.commands.executeCommand('workbench.action.evenEditorWidths').catch(() => {});
  }, 2000);

  checkForUpdates(workspaceRoot);
}

export function deactivate() {}

// ─── Config Reading ──────────────────────────────────────────────────────────

interface SiteConfig {
  name: string;
  description: string;
  theme: { color: string; tealColor: string };
}

function readSiteConfig(workspaceRoot: string): SiteConfig {
  const defaults: SiteConfig = {
    name: 'TabulaKit',
    description: 'A TabulaKit documentation site',
    theme: { color: '#e84118', tealColor: '#3bc0cb' }
  };
  try {
    const content = fs.readFileSync(path.join(workspaceRoot, 'site', 'config.js'), 'utf8');
    const nameMatch = content.match(/name:\s*"([^"]+)"/);
    if (nameMatch) defaults.name = nameMatch[1];
    const descMatch = content.match(/description:\s*"([^"]+)"/);
    if (descMatch) defaults.description = descMatch[1];
    const colorMatch = content.match(/color:\s*"([^"]+)"/);
    if (colorMatch) defaults.theme.color = colorMatch[1];
    const tealMatch = content.match(/tealColor:\s*"([^"]+)"/);
    if (tealMatch) defaults.theme.tealColor = tealMatch[1];
  } catch {}
  return defaults;
}

function ensurePreviewPort(workspaceRoot: string): number {
  const configPath = path.join(workspaceRoot, '.tabulakit', 'config.json');
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (typeof config.previewPort === 'number' && config.previewPort >= 3100 && config.previewPort <= 3800) {
      return config.previewPort;
    }
  } catch {}
  const port = 3100 + Math.floor(Math.random() * 701);
  try {
    let config: Record<string, unknown> = {};
    try { config = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch {}
    config.previewPort = port;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
  } catch {}
  return port;
}

function readTabulaKitConfig(workspaceRoot: string): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(path.join(workspaceRoot, '.tabulakit', 'config.json'), 'utf8'));
  } catch { return {}; }
}

function writeTabulaKitConfig(workspaceRoot: string, config: Record<string, unknown>) {
  try {
    fs.writeFileSync(
      path.join(workspaceRoot, '.tabulakit', 'config.json'),
      JSON.stringify(config, null, 2) + '\n', 'utf8'
    );
  } catch {}
}

// ─── Preview Server ──────────────────────────────────────────────────────────
// The preview server is the ONLY thing that uses a terminal (it runs continuously).

function startPreviewServer(workspaceRoot: string, port: number) {
  // Check if we already have a preview terminal
  const existing = vscode.window.terminals.find(t => t.name === 'TabulaKit Preview');
  if (existing) {
    setTimeout(() => dashboardPanel?.webview.postMessage({ command: 'serverStarted' }), 500);
    return;
  }

  // Start the server — don't bother probing the port, just start it.
  // If port is taken, live-server will fail with a clear message.
  const terminal = vscode.window.createTerminal({
    name: 'TabulaKit Preview',
    location: vscode.TerminalLocation.Panel,
  });
  terminal.sendText(`cd "${workspaceRoot}/site" && npx live-server --port=${port} --no-browser`);
  setTimeout(() => dashboardPanel?.webview.postMessage({ command: 'serverStarted' }), 3500);
}

// ─── Layout ──────────────────────────────────────────────────────────────────

function applyTabulaKitLayout() {
  const config = vscode.workspace.getConfiguration();
  config.update('terminal.integrated.defaultLocation', 'view', vscode.ConfigurationTarget.Workspace);
  config.update('editor.minimap.enabled', false, vscode.ConfigurationTarget.Workspace);
  config.update('breadcrumbs.enabled', false, vscode.ConfigurationTarget.Workspace);
  config.update('workbench.tips.enabled', false, vscode.ConfigurationTarget.Workspace);
  config.update('workbench.startupEditor', 'none', vscode.ConfigurationTarget.Workspace);
}

// ─── Dashboard ───────────────────────────────────────────────────────────────

function showDashboard(context: vscode.ExtensionContext, workspaceRoot: string, config: SiteConfig, port: number) {
  if (dashboardPanel) {
    dashboardPanel.reveal(vscode.ViewColumn.One);
    return;
  }

  dashboardPanel = vscode.window.createWebviewPanel(
    'tabulakit.dashboard', config.name, vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true }
  );

  vscode.commands.executeCommand('workbench.action.experimentalLockGroup').catch(() => {});

  const state = detectProjectState(workspaceRoot, port);
  dashboardPanel.webview.html = getDashboardHtml(config, state, port);

  dashboardPanel.webview.onDidReceiveMessage(message => {
    switch (message.command) {
      case 'startServer':
        startPreviewServer(workspaceRoot, port);
        break;
      case 'publish':
        executePublish(workspaceRoot);
        break;
      case 'resetLayout':
        vscode.commands.executeCommand('tabulakit.resetLayout');
        break;
      case 'checkUpdates':
        checkForUpdates(workspaceRoot);
        break;
      case 'openExternal':
        if (message.url) vscode.env.openExternal(vscode.Uri.parse(message.url));
        break;
    }
  });

  dashboardPanel.onDidDispose(() => { dashboardPanel = undefined; });

  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(workspaceRoot, '{site/**,firebase.json,.claude/**}')
  );
  const refresh = () => {
    if (!dashboardPanel) return;
    dashboardPanel.webview.postMessage({
      command: 'updateState',
      state: detectProjectState(workspaceRoot, port)
    });
  };
  watcher.onDidChange(refresh);
  watcher.onDidCreate(refresh);
  watcher.onDidDelete(refresh);
  context.subscriptions.push(watcher);
}

// ─── Project State ───────────────────────────────────────────────────────────

interface ProjectState {
  hosting: string[];
  siteUrls: string[];
  authMode: string;
  previewPort: number;
  extensionVersion: string;
}

function detectProjectState(workspaceRoot: string, port: number): ProjectState {
  const hosting: string[] = [];
  const siteUrls: string[] = [];

  if (fs.existsSync(path.join(workspaceRoot, '.github', 'workflows', 'deploy.yml'))) {
    hosting.push('GitHub Pages');
    // Detect GitHub Pages URL from git remote
    try {
      const remote = execSync('git remote get-url origin', { cwd: workspaceRoot, encoding: 'utf8' }).trim();
      const m = remote.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
      if (m) siteUrls.push(`https://${m[1].toLowerCase()}.github.io/${m[2]}/`);
    } catch {}
  }

  if (fs.existsSync(path.join(workspaceRoot, 'firebase.json'))) {
    hosting.push('Firebase');
    try {
      const rc = fs.readFileSync(path.join(workspaceRoot, '.firebaserc'), 'utf8');
      const m = rc.match(/"default":\s*"([^"]+)"/);
      if (m) siteUrls.push(`https://${m[1]}.web.app`);
    } catch {}
  }

  if (fs.existsSync(path.join(workspaceRoot, 'netlify.toml'))) {
    hosting.push('Netlify');
    // Netlify URL requires the site name which isn't in config — skip for now
  }

  let authMode = 'n/a';
  if (hosting.includes('Firebase')) {
    authMode = 'public';
    try {
      const content = fs.readFileSync(path.join(workspaceRoot, 'site', 'auth-config.js'), 'utf8');
      const m = content.match(/mode:\s*"([^"]+)"/);
      if (m) authMode = m[1];
    } catch {}
  }

  return { hosting, siteUrls, authMode, previewPort: port, extensionVersion: '0.2.0' };
}

// ─── Publish (runs in background, shows notification) ────────────────────────

function executePublish(workspaceRoot: string) {
  // Prefer sending /publish to Claude Code if it's open
  const claudeTerminal = vscode.window.terminals.find(t => t.name.toLowerCase().includes('claude'));
  if (claudeTerminal) {
    claudeTerminal.sendText('/publish');
    claudeTerminal.show(true);
    return;
  }

  // Fallback: run via exec (no terminal spawned)
  const hasFirebase = fs.existsSync(path.join(workspaceRoot, 'firebase.json'));

  vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Publishing changes...' },
    async () => {
      try {
        // Check for changes
        try {
          execSync('git diff --quiet && git diff --cached --quiet', { cwd: workspaceRoot });
          // Check untracked files
          const untracked = execSync('git ls-files --others --exclude-standard', { cwd: workspaceRoot, encoding: 'utf8' }).trim();
          if (!untracked) {
            vscode.window.showInformationMessage('Nothing to publish — no changes found.');
            return;
          }
        } catch {
          // git diff --quiet exits non-zero when there ARE changes — that's what we want
        }

        execSync('git add -A', { cwd: workspaceRoot });
        // Check if anything is staged now
        try {
          execSync('git diff --cached --quiet', { cwd: workspaceRoot });
          vscode.window.showInformationMessage('Nothing to publish — no changes found.');
          return;
        } catch {
          // There are staged changes — proceed
        }

        execSync('git commit -m "Update site content"', { cwd: workspaceRoot });
        execSync('git push', { cwd: workspaceRoot, timeout: 30000 });

        if (hasFirebase) {
          try {
            execSync('firebase deploy --only hosting', { cwd: workspaceRoot, timeout: 60000 });
          } catch (e: any) {
            vscode.window.showWarningMessage('Changes pushed but Firebase deploy failed: ' + (e.message || ''));
            return;
          }
        }

        vscode.window.showInformationMessage('Published! Your changes are now live.');
      } catch (e: any) {
        vscode.window.showErrorMessage('Publish failed: ' + (e.message || 'Unknown error'));
      }
    }
  );
}

// ─── Update Check (compares file content, not commit history) ────────────────

async function checkForUpdates(workspaceRoot: string) {
  const UPSTREAM_REPO = 'https://github.com/heatherstoneio/tabulakit.git';
  const FRAMEWORK_FILES = [
    'site/index.html', 'site/css/tabulakit.css',
    '.github/workflows/deploy.yml', 'firebase.json', 'netlify.toml',
    '.claude/CLAUDE.md', '.claude/commands/publish.md',
    '.claude/commands/tabula-update.md', '.claude/settings.json',
  ];

  try {
    // Ensure upstream remote
    try {
      const remotes = execSync('git remote -v', { cwd: workspaceRoot, encoding: 'utf8' });
      if (!remotes.includes('upstream')) {
        execSync(`git remote add upstream ${UPSTREAM_REPO}`, { cwd: workspaceRoot, encoding: 'utf8' });
      }
    } catch { return; }

    // Fetch
    try {
      execSync('git fetch upstream main --quiet', { cwd: workspaceRoot, encoding: 'utf8', timeout: 15000 });
    } catch { return; }

    // Compare framework file content between HEAD and upstream/main
    const fileArgs = FRAMEWORK_FILES.map(f => `"${f}"`).join(' ');
    let diff = '';
    try {
      diff = execSync(`git diff HEAD upstream/main --stat -- ${fileArgs}`, { cwd: workspaceRoot, encoding: 'utf8' }).trim();
    } catch { return; }

    if (!diff) {
      // Framework files are identical — we're up to date
      const config = readTabulaKitConfig(workspaceRoot);
      try {
        config.lastUpstreamSync = execSync('git rev-parse upstream/main', { cwd: workspaceRoot, encoding: 'utf8' }).trim();
        writeTabulaKitConfig(workspaceRoot, config);
      } catch {}
      vscode.window.showInformationMessage('TabulaKit is up to date — no new updates available.');
      return;
    }

    // Parse which files changed
    const changedFiles = diff.split('\n').filter(l => l.includes('|')).map(l => l.split('|')[0].trim());
    const count = changedFiles.length;
    const summary = changedFiles.slice(0, 3).join(', ');

    const choice = await vscode.window.showInformationMessage(
      `TabulaKit has updates to ${count} framework file${count === 1 ? '' : 's'}: ${summary}`,
      'Update Now', 'Remind Me Later'
    );

    if (choice === 'Update Now') {
      vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Applying TabulaKit updates...' },
        async () => {
          try {
            // Checkout each framework file from upstream
            for (const f of FRAMEWORK_FILES) {
              try {
                execSync(`git checkout upstream/main -- "${f}"`, { cwd: workspaceRoot });
              } catch {} // File might not exist upstream — that's fine
            }

            execSync('git add -A', { cwd: workspaceRoot });

            // Check if anything actually changed
            try {
              execSync('git diff --cached --quiet', { cwd: workspaceRoot });
              vscode.window.showInformationMessage('Already up to date.');
            } catch {
              execSync('git commit -m "chore: update TabulaKit framework to latest upstream"', { cwd: workspaceRoot });
              execSync('git push', { cwd: workspaceRoot, timeout: 30000 });
              vscode.window.showInformationMessage('Updated and published! Your site now has the latest TabulaKit improvements.');
            }

            // Save sync marker
            const cfg = readTabulaKitConfig(workspaceRoot);
            cfg.lastUpstreamSync = execSync('git rev-parse upstream/main', { cwd: workspaceRoot, encoding: 'utf8' }).trim();
            writeTabulaKitConfig(workspaceRoot, cfg);
          } catch (e: any) {
            vscode.window.showErrorMessage('Update failed: ' + (e.message || 'Unknown error'));
          }
        }
      );
    }
  } catch {}
}

// ─── Dashboard HTML ──────────────────────────────────────────────────────────

function getDashboardHtml(config: SiteConfig, state: ProjectState, port: number): string {
  const { color, tealColor } = config.theme;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #1e1e1e; color: #ddd;
      height: 100vh; display: flex; flex-direction: column; overflow: hidden;
    }
    .tab-bar { display: flex; background: #252526; border-bottom: 1px solid #3a3a3a; flex-shrink: 0; }
    .tab { padding: 10px 20px; cursor: pointer; font-size: 13px; color: #888; border-bottom: 2px solid transparent; transition: all 0.15s; user-select: none; }
    .tab:hover { color: #ddd; }
    .tab.active { color: ${tealColor}; border-bottom-color: ${tealColor}; }
    .tab-content { flex: 1; overflow: hidden; position: relative; }
    .tab-pane { position: absolute; top: 0; left: 0; right: 0; bottom: 0; display: none; overflow: auto; }
    .tab-pane.active { display: flex; flex-direction: column; }

    .preview-wrapper { flex: 1; overflow: hidden; position: relative; }
    .preview-frame { border: none; background: #222; position: absolute; top: 0; left: 0; transform-origin: 0 0; }
    .preview-placeholder { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 16px; color: #888; }
    .preview-placeholder h2 { color: ${color}; font-size: 18px; }
    .preview-bar { display: flex; align-items: center; gap: 8px; padding: 6px 12px; background: #252526; border-bottom: 1px solid #3a3a3a; flex-shrink: 0; }
    .preview-bar input { flex: 1; background: #3a3a3a; border: 1px solid #555; color: #ddd; padding: 4px 8px; border-radius: 3px; font-size: 12px; }
    .preview-bar button { background: none; border: none; color: #888; cursor: pointer; font-size: 14px; padding: 4px 8px; }
    .preview-bar button:hover { color: #ddd; }
    .zoom-controls { display: flex; align-items: center; gap: 2px; margin-left: 4px; border-left: 1px solid #555; padding-left: 8px; }
    .zoom-controls span { font-size: 11px; color: #888; min-width: 36px; text-align: center; }

    .panel-content { padding: 24px 32px; max-width: 700px; line-height: 1.7; font-size: 14px; }
    .panel-content h1 { color: ${color}; font-size: 22px; margin-bottom: 16px; }
    .panel-content h2 { color: ${color}; font-size: 17px; margin: 24px 0 12px; }
    .panel-content h3 { color: #ddd; font-size: 15px; margin: 18px 0 8px; }
    .panel-content p { margin: 8px 0; }
    .panel-content code { background: #2d2d2d; padding: 2px 6px; border-radius: 3px; color: ${tealColor}; font-size: 13px; }
    .panel-content ul { padding-left: 20px; margin: 8px 0; }
    .panel-content li { margin: 4px 0; }
    .tip { background: #2a2a2a; border-left: 3px solid ${tealColor}; padding: 12px 16px; margin: 12px 0; border-radius: 0 4px 4px 0; }

    .status-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin: 16px 0; }
    .status-card { background: #2a2a2a; border-radius: 6px; padding: 14px 16px; border-left: 3px solid #555; }
    .status-card .label { font-size: 11px; text-transform: uppercase; color: #888; letter-spacing: 0.05em; }
    .status-card .value { font-size: 14px; margin-top: 4px; color: #ddd; }

    .btn { display: inline-flex; align-items: center; gap: 6px; padding: 8px 16px; border: none; border-radius: 4px; font-size: 13px; cursor: pointer; }
    .btn:hover { opacity: 0.85; }
    .btn-primary { background: ${color}; color: #ffffff; }
    .btn-secondary { background: ${color}; color: #ffffff; }
    a.site-link { color: ${tealColor}; font-size: 13px; text-decoration: none; }
    a.site-link:hover { text-decoration: underline; }
    .site-links { margin: 8px 0; }
    .button-row { display: flex; gap: 8px; margin: 12px 0; flex-wrap: wrap; }
  </style>
</head>
<body>
  <div class="tab-bar">
    <div class="tab active" data-tab="preview">Site Preview</div>
    <div class="tab" data-tab="status">TabulaKit</div>
    <div class="tab" data-tab="help">Help</div>
  </div>

  <div class="tab-content">
    <div id="tab-preview" class="tab-pane active">
      <div class="preview-bar">
        <input type="text" id="preview-url" value="http://localhost:${port}" />
        <button onclick="refreshPreview()" title="Refresh">&#x21bb;</button>
        <button onclick="startServer()" title="Start server">&#x25b6;</button>
        <div class="zoom-controls">
          <button onclick="zoomOut()" title="Zoom out">&#x2212;</button>
          <span id="zoom-level">75%</span>
          <button onclick="zoomIn()" title="Zoom in">&#x2b;</button>
          <button onclick="zoomReset()" title="Reset zoom">&#x25a2;</button>
        </div>
      </div>
      <div class="preview-wrapper">
        <iframe id="preview-iframe" class="preview-frame" src="http://localhost:${port}"></iframe>
      </div>
      <div id="preview-placeholder" class="preview-placeholder" style="display:none">
        <h2>Site Preview</h2>
        <p>The local preview server isn't running yet.</p>
        <button class="btn btn-primary" onclick="startServer()">&#x25b6; Start Preview</button>
      </div>
    </div>

    <div id="tab-status" class="tab-pane">
      <div class="panel-content">
        <h1>${esc(config.name)}</h1>
        <p style="color:#888;margin:4px 0 20px;font-size:13px;">${esc(config.description)}</p>

        <div class="status-grid">
          <div class="status-card">
            <div class="label">Hosting</div>
            <div class="value">${state.hosting.length ? state.hosting.join(', ') : 'Not configured'}</div>
          </div>
          <div class="status-card">
            <div class="label">Preview</div>
            <div class="value">Port ${state.previewPort}</div>
          </div>
          ${state.hosting.includes('Firebase') ? `<div class="status-card">
            <div class="label">Authentication</div>
            <div class="value">${state.authMode === 'public' ? 'Public (no sign-in)' : state.authMode === 'domain' ? 'Domain restricted' : state.authMode === 'allowlist' ? 'Allowlist' : state.authMode}</div>
          </div>` : ''}
          <div class="status-card">
            <div class="label">Extension</div>
            <div class="value">v${state.extensionVersion}</div>
          </div>
        </div>

        ${state.siteUrls.length ? `<h2>Published Sites</h2>
        <div class="site-links">
          ${state.siteUrls.map(url => `<div style="margin:4px 0"><a class="site-link" href="#" onclick="vscode.postMessage({command:'openExternal',url:'${url}'});return false">${url}</a></div>`).join('')}
        </div>` : ''}

        <h2>Actions</h2>
        <div class="button-row">
          <button class="btn btn-primary" onclick="vscode.postMessage({command:'startServer'})">Start Preview</button>
          <button class="btn btn-primary" onclick="vscode.postMessage({command:'publish'})">Publish Changes</button>
          <button class="btn btn-primary" onclick="vscode.postMessage({command:'checkUpdates'})">Check for Updates</button>
          <button class="btn btn-primary" onclick="vscode.postMessage({command:'openExternal', url:'https://discord.gg/heatherstone-academy'})">Discord Community</button>
        </div>
      </div>
    </div>

    <div id="tab-help" class="tab-pane">
      <div class="panel-content">
        <h1>Welcome to ${esc(config.name)}</h1>
        <p>${esc(config.description)}</p>

        <h2>How This Works</h2>
        <p>This is your documentation site builder. The primary way to work is by <strong>talking to Claude Code</strong> in the panel on the right. Just describe what you want in plain language.</p>
        <div class="tip"><strong>Try saying:</strong> "Add a new page called Team Members with a table of names and roles"</div>

        <h2>Common Tasks</h2>
        <h3>Add or edit content</h3>
        <p>Tell Claude Code what you want to change. For example:</p>
        <ul>
          <li>"Update the home page welcome message"</li>
          <li>"Add a new section about our timeline"</li>
          <li>"Change the sidebar navigation order"</li>
        </ul>

        <h3>Change the look</h3>
        <ul>
          <li>"Make the accent color blue instead of orange"</li>
          <li>"Increase the font size"</li>
          <li>"Change the site title"</li>
        </ul>

        <h3>Save and publish</h3>
        <p>When you're ready to publish your changes, tell Claude Code:</p>
        <ul>
          <li>"Save and publish these changes"</li>
          <li>"Push this to the live site"</li>
        </ul>
        <p>Or use the <strong>Publish Changes</strong> button on the TabulaKit tab.</p>

        <h2>Keyboard Shortcuts</h2>
        <ul>
          <li><code>Ctrl+Shift+P</code> — Command palette (search for TabulaKit commands)</li>
          <li><code>Ctrl+Shift+\`</code> — Toggle terminal</li>
        </ul>

        <h2>Need Help?</h2>
        <p>Just ask Claude Code! It knows about your site's structure, configuration, and deployment setup.</p>
      </div>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const iframe = document.getElementById('preview-iframe');
    const placeholder = document.getElementById('preview-placeholder');
    const urlInput = document.getElementById('preview-url');
    const zoomLabel = document.getElementById('zoom-level');

    let zoomLevel = 0.75;
    function applyZoom() {
      iframe.style.transform = 'scale(' + zoomLevel + ')';
      iframe.style.width = (100 / zoomLevel) + '%';
      iframe.style.height = (100 / zoomLevel) + '%';
      zoomLabel.textContent = Math.round(zoomLevel * 100) + '%';
    }
    function zoomIn() { zoomLevel = Math.min(1.5, zoomLevel + 0.1); applyZoom(); }
    function zoomOut() { zoomLevel = Math.max(0.25, zoomLevel - 0.1); applyZoom(); }
    function zoomReset() { zoomLevel = 0.75; applyZoom(); }
    applyZoom();

    document.querySelectorAll('.tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
      });
    });

    function refreshPreview() { iframe.src = urlInput.value; }
    function startServer() { vscode.postMessage({ command: 'startServer' }); }

    window.addEventListener('message', event => {
      const msg = event.data;
      if (msg.command === 'refreshPreview') refreshPreview();
      else if (msg.command === 'serverStarted') {
        setTimeout(() => {
          iframe.style.display = '';
          placeholder.style.display = 'none';
          iframe.src = urlInput.value;
        }, 1000);
      }
    });

    iframe.addEventListener('error', () => {
      iframe.style.display = 'none';
      placeholder.style.display = 'flex';
    });
  </script>
</body>
</html>`;
}

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── Sidebar Welcome Panel ───────────────────────────────────────────────────

class WelcomeViewProvider implements vscode.WebviewViewProvider {
  constructor(private config: SiteConfig) {}

  resolveWebviewView(view: vscode.WebviewView) {
    view.webview.options = { enableScripts: true };
    const c = this.config.theme.color;
    view.webview.html = `<!DOCTYPE html>
<html><head><meta name="color-scheme" content="dark"><style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 12px; color: #ccc; font-size: 13px; background: transparent; }
  .name { font-size: 14px; font-weight: 700; color: ${c}; margin: 0 0 4px; }
  .desc { color: #888; font-size: 11px; margin: 0 0 10px; line-height: 1.4; }
  .hint { color: #999; font-size: 12px; line-height: 1.5; margin: 0 0 10px; }
  .btn { display: block; width: 100%; padding: 8px 10px; margin: 4px 0; border: none; border-radius: 4px; font-size: 12px; cursor: pointer; background: ${c}; color: #fff; }
  .btn:hover { opacity: 0.85; }
</style></head><body>
  <p class="name">${esc(this.config.name)}</p>
  <p class="desc">${esc(this.config.description)}</p>
  <button class="btn" onclick="vscode.postMessage({command:'open'})">Open Dashboard</button>
  <script>const vscode = acquireVsCodeApi();</script>
</body></html>`;

    view.webview.onDidReceiveMessage(msg => {
      if (msg.command === 'open') vscode.commands.executeCommand('tabulakit.showDashboard');
    });
  }
}
