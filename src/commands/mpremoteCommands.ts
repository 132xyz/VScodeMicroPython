import * as vscode from "vscode";
import * as path from "node:path";
import { exec, execFile } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

/**
 * Mpremote installation and management commands
 */
export const mpremoteCommands = {
  /**
   * Check if mpremote is available and show installation guide if not
   */
  async checkAndInstallMpremote(): Promise<boolean> {
    try {
      // Check if mpremote is available
      await execAsync('mpremote --version');
      return true; // Already available
    } catch (error) {
      // Mpremote not found, show installation guide
      await this.showMpremoteInstallationGuide();
      return false;
    }
  },

  /**
   * Show comprehensive mpremote installation guide
   */
  async showMpremoteInstallationGuide(): Promise<void> {
    const selection = await vscode.window.showWarningMessage(
      'MicroPython WorkBench requires mpremote to communicate with your MicroPython board.',
      { modal: true },
      'Install Automatically',
      'Manual Installation',
      'Learn More'
    );

    if (selection === 'Install Automatically') {
      await this.installMpremoteAutomatically();
    } else if (selection === 'Manual Installation') {
      await this.showManualInstallationInstructions();
    } else if (selection === 'Learn More') {
      await this.showMpremoteInformation();
    }
  },

  /**
   * Automatically install mpremote using detected Python environment
   */
  async installMpremoteAutomatically(): Promise<void> {
    const pythonPath = await this.detectPythonPath();

    if (!pythonPath) {
      vscode.window.showErrorMessage(
        'Could not detect Python installation. Please install Python first, then run manual installation.'
      );
      await this.showManualInstallationInstructions();
      return;
    }

    const installCommand = `"${pythonPath}" -m pip install mpremote`;

    const installPromise = vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: 'Installing mpremote...',
      cancellable: true
    }, async (progress, token) => {
      return new Promise<void>((resolve, reject) => {
        progress.report({ increment: 10, message: 'Starting installation...' });

        const installProcess = exec(installCommand, { cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath });

        token.onCancellationRequested(() => {
          installProcess.kill();
          reject(new Error('Installation cancelled'));
        });

        installProcess.on('close', (code) => {
          if (code === 0) {
            progress.report({ increment: 100, message: 'Installation completed successfully!' });
            vscode.window.showInformationMessage(
              'mpremote installed successfully! Please restart VS Code to use all features.',
              'Restart Now'
            ).then(choice => {
              if (choice === 'Restart Now') {
                vscode.commands.executeCommand('workbench.action.reloadWindow');
              }
            });
            resolve();
          } else {
            reject(new Error(`Installation failed with exit code ${code}`));
          }
        });

        installProcess.on('error', (error) => {
          reject(error);
        });

        // Monitor progress
        let lastProgress = 10;
        const progressInterval = setInterval(() => {
          if (lastProgress < 90) {
            lastProgress += 10;
            progress.report({ increment: lastProgress, message: 'Installing...' });
          }
        }, 1000);

        installProcess.on('close', () => {
          clearInterval(progressInterval);
        });
      });
    });

    try {
      await installPromise;
    } catch (error: any) {
      console.error('Mpremote installation failed:', error);
      vscode.window.showErrorMessage(
        `Failed to install mpremote: ${error.message}`,
        'Try Manual Installation'
      ).then(choice => {
        if (choice === 'Try Manual Installation') {
          this.showManualInstallationInstructions();
        }
      });
    }
  },

  /**
   * Show manual installation instructions
   */
  async showManualInstallationInstructions(): Promise<void> {
    const isWindows = process.platform === 'win32';
    const isMac = process.platform === 'darwin';

    let instructions: string;
    let command: string;

    if (isWindows) {
      command = 'python -m pip install mpremote';
      instructions = `**Windows Installation:**

1. Open Command Prompt or PowerShell as Administrator
2. Run: \`${command}\`
3. Restart VS Code

**Alternative methods:**
- Using conda: \`conda install mpremote\`
- Using winget: \`winget install --id=python.mpremote\``;
    } else if (isMac) {
      command = 'python3 -m pip install mpremote';
      instructions = `**macOS Installation:**

1. Open Terminal
2. Run: \`${command}\`
3. Restart VS Code

**Alternative methods:**
- Using Homebrew: \`brew install mpremote\`
- Using conda: \`conda install mpremote\``;
    } else {
      // Linux
      command = 'python3 -m pip install mpremote';
      instructions = `**Linux Installation:**

1. Open Terminal
2. Run: \`${command}\`
3. Restart VS Code

**Alternative methods:**
- Using apt: \`sudo apt install python3-mpremote\`
- Using conda: \`conda install mpremote\`
- Using snap: \`sudo snap install mpremote\``;
    }

    const result = await vscode.window.showInformationMessage(
      'Manual Installation Instructions',
      { modal: true, detail: instructions },
      'Copy Command',
      'Open Terminal',
      'Visit Documentation'
    );

    if (result === 'Copy Command') {
      await vscode.env.clipboard.writeText(command);
      vscode.window.showInformationMessage('Installation command copied to clipboard');
    } else if (result === 'Open Terminal') {
      await vscode.commands.executeCommand('workbench.action.terminal.new');
      // Could potentially paste the command, but VS Code doesn't have a direct API for this
    } else if (result === 'Visit Documentation') {
      await vscode.env.openExternal(vscode.Uri.parse('https://pypi.org/project/mpremote/'));
    }
  },

  /**
   * Show information about mpremote
   */
  async showMpremoteInformation(): Promise<void> {
    const info = `**What is mpremote?**

mpremote is a command-line tool for communicating with MicroPython boards. It allows you to:
- Upload and download files to/from your board
- Access the MicroPython REPL
- Run scripts directly on the board
- Manage board filesystem

**Why do I need it?**

MicroPython WorkBench uses mpremote to provide all its functionality. Without mpremote, you cannot:
- Browse files on your MicroPython board
- Upload code to the board
- Run code on the board
- Use the REPL terminal

**Installation Options:**
- **Automatic**: Let the extension install it for you
- **Manual**: Install using your system's package manager
- **Conda**: If using Anaconda/Miniconda
- **System package**: apt, brew, winget, etc.

For more information, visit: https://pypi.org/project/mpremote/`;

    await vscode.window.showInformationMessage(
      'About mpremote',
      { modal: true, detail: info },
      'Install Now',
      'Visit Website'
    ).then(choice => {
      if (choice === 'Install Now') {
        this.installMpremoteAutomatically();
      } else if (choice === 'Visit Website') {
        vscode.env.openExternal(vscode.Uri.parse('https://pypi.org/project/mpremote/'));
      }
    });
  },

  /**
   * Detect Python path for installation
   */
  async detectPythonPath(): Promise<string | null> {
    // Try multiple methods to find Python

    // Method 1: Check VS Code Python extension
    try {
      const pythonExtension = vscode.extensions.getExtension('ms-python.python');
      if (pythonExtension && pythonExtension.isActive) {
        const pythonApi = pythonExtension.exports;
        if (pythonApi && pythonApi.settings && pythonApi.settings.getExecutionDetails) {
          const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
          const executionDetails = pythonApi.settings.getExecutionDetails(workspaceFolder?.uri);
          if (executionDetails && executionDetails.execCommand && executionDetails.execCommand.length > 0) {
            return executionDetails.execCommand[0];
          }
        }
      }
    } catch (error) {
      console.log('Failed to get Python from extension API:', error);
    }

    // Method 2: Check configuration
    const config = vscode.workspace.getConfiguration('python');
    const configuredPath = config.get<string>('defaultInterpreterPath') || config.get<string>('pythonPath');
    if (configuredPath) {
      try {
        await execFileAsync(configuredPath, ['--version']);
        return configuredPath;
      } catch (error) {
        // Continue to next method
      }
    }

    // Method 3: Try common Python executables
    const candidates = process.platform === 'win32'
      ? ['python', 'python3', 'py', 'py -3']
      : ['python3', 'python'];

    for (const candidate of candidates) {
      try {
        await execFileAsync(candidate, ['--version']);
        return candidate;
      } catch (error) {
        // Continue to next candidate
      }
    }

    return null;
  },

  /**
   * Check mpremote version and compatibility
   */
  async checkMpremoteVersion(): Promise<{ version: string | null; compatible: boolean }> {
    try {
      const { stdout } = await execAsync('mpremote --version');
      const versionMatch = stdout.match(/(\d+\.\d+\.\d+)/);
      const version = versionMatch ? versionMatch[1] : null;

      // Check if version is compatible (mpremote 1.20.0+ recommended)
      const compatible = version ? this.isVersionCompatible(version) : false;

      return { version, compatible };
    } catch (error) {
      return { version: null, compatible: false };
    }
  },

  /**
   * Check if mpremote version is compatible
   */
  isVersionCompatible(version: string): boolean {
    const parts = version.split('.').map(Number);
    if (parts.length < 2) return false;

    const major = parts[0];
    const minor = parts[1];

    // Require at least version 1.20
    return major > 1 || (major === 1 && minor >= 20);
  },

  /**
   * Show status bar item for mpremote status
   */
  createStatusBarItem(): vscode.StatusBarItem {
    const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBarItem.command = 'microPythonWorkBench.installMpremote';

    this.updateStatusBarItem(statusBarItem);
    return statusBarItem;
  },

  /**
   * Update status bar item based on mpremote availability
   */
  async updateStatusBarItem(statusBarItem: vscode.StatusBarItem): Promise<void> {
    const { version, compatible } = await this.checkMpremoteVersion();

    if (!version) {
      statusBarItem.text = '$(warning) mpremote: Not Installed';
      statusBarItem.tooltip = 'Click to install mpremote';
      statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      statusBarItem.show();
    } else if (!compatible) {
      statusBarItem.text = `$(warning) mpremote: ${version} (Outdated)`;
      statusBarItem.tooltip = 'mpremote version may be outdated. Click to update.';
      statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      statusBarItem.show();
    } else {
      statusBarItem.text = `$(check) mpremote: ${version}`;
      statusBarItem.tooltip = 'mpremote is ready';
      statusBarItem.backgroundColor = undefined;
      statusBarItem.show();
    }
  }
};