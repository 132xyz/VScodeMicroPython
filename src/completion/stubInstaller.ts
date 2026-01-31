import * as child from 'child_process';
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';

export async function installStubPackage(pkgName: string, targetDir: string): Promise<string> {
  // Ensure target exists
  try {
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
  } catch (e) {
    throw new Error(`无法创建目标目录: ${targetDir}`);
  }

  // Compose command: prefer `python -m pip` but fall back to `pip`
  const candidates = ["python -m pip", "python3 -m pip", "pip"]; 

  return await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Installing ${pkgName}` }, async (progress, token) => {
    progress.report({ increment: 0, message: '开始安装...' });

    let sawVersionCandidates: string[] | null = null;
    for (const cand of candidates) {
      if (token.isCancellationRequested) throw new Error('Installation cancelled');
      const parts = cand.split(' ');
      const cmd = parts[0];

      // Create per-package/version subdirectory under targetDir so multiple versions can coexist.
      // pkgName may contain '==version' spec; derive a safe folder name.
      const baseName = pkgName.split('==')[0];
      const versionSpec = (pkgName.includes('==') ? pkgName.split('==')[1] : '').replace(/[^a-zA-Z0-9._-]/g, '_');
      const subdirName = versionSpec ? `${baseName}-${versionSpec}` : baseName;
      const installSubdir = path.join(targetDir, subdirName);
      try { if (!fs.existsSync(installSubdir)) fs.mkdirSync(installSubdir, { recursive: true }); } catch (e) { /* ignore */ }

      const args = parts.slice(1).concat(['install', '--no-user', '--target', installSubdir, pkgName]);

      try {
        await new Promise<void>((resolve, reject) => {
          const proc = child.spawn(cmd, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
          let out = '';
          let err = '';
          proc.stdout.on('data', d => { out += String(d); });
          proc.stderr.on('data', d => { err += String(d); });
          proc.on('error', e => reject(e));
          proc.on('close', code => {
            if (code === 0) resolve();
            else reject(new Error(err || `pip exited ${code}`));
          });
        });
        progress.report({ increment: 100, message: '安装完成' });
        // Return installed subdirectory path
        return installSubdir;
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        console.warn(`installStubPackage: candidate ${cand} failed:`, errMsg);

        // If pip reports "Could not find a version... (from versions: ...)", parse available versions
        const combined = (errMsg || '') + '\n';
        const m = /from versions:\s*([^\)\n]+)/i.exec(combined);
        if (m) {
          const versionsRaw = m[1];
          const versions = versionsRaw.split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
          if (versions.length > 0) {
            sawVersionCandidates = versions;
            // Ask user to choose a version or pick latest
            const latest = versions.slice().sort((a, b) => {
              const pa = a.split(/[^0-9]+/).map(x=>Number(x||0));
              const pb = b.split(/[^0-9]+/).map(x=>Number(x||0));
              for (let i=0;i<Math.max(pa.length,pb.length);i++){
                const na = pa[i]||0; const nb = pb[i]||0; if (na!==nb) return nb-na;
              }
              return 0;
            })[0];

            const pick = await vscode.window.showQuickPick([
              { label: `Install latest available ${latest}`, description: '' },
              { label: 'Choose specific version...', description: '从可用版本列表中选择' },
              { label: 'Cancel', description: '取消安装' }
            ], { placeHolder: `未找到请求的版本，PyPI 上可用的版本: ${versions.slice(0,6).join(', ')}${versions.length>6? ', ...':''}` });

            if (!pick || pick.label === 'Cancel') throw new Error('用户取消安装');

            let chosenVersion: string | undefined;
            if (pick.label.startsWith('Install latest')) {
              chosenVersion = latest;
            } else {
              const sel = await vscode.window.showQuickPick(versions.map(v=>({label:v})), { placeHolder: '选择要安装的版本' });
              if (!sel) throw new Error('用户取消安装');
              chosenVersion = sel.label;
            }

            // Construct package name without existing == spec
            const base = pkgName.split('==')[0];
            const newPkg = `${base}==${chosenVersion}`;
            // Try installing chosen version immediately with same candidate
            progress.report({ message: `尝试安装 ${newPkg} ...` });
            const parts2 = cand.split(' ');
            const cmd2 = parts2[0];
            // determine new subdir for chosenVersion
            const base2 = newPkg.split('==')[0];
            const v2 = (newPkg.split('==')[1] || '').replace(/[^a-zA-Z0-9._-]/g, '_');
            const subdir2 = v2 ? `${base2}-${v2}` : base2;
            const installSubdir2 = path.join(targetDir, subdir2);
            try { if (!fs.existsSync(installSubdir2)) fs.mkdirSync(installSubdir2, { recursive: true }); } catch (e) { /* ignore */ }
            const args2 = parts2.slice(1).concat(['install', '--no-user', '--target', installSubdir2, newPkg]);
            await new Promise<void>((resolve2, reject2) => {
              const proc2 = child.spawn(cmd2, args2, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
              let o2 = '';
              let e2 = '';
              proc2.stdout.on('data', d => { o2 += String(d); });
              proc2.stderr.on('data', d => { e2 += String(d); });
              proc2.on('error', err2 => reject2(err2));
              proc2.on('close', code2 => { if (code2===0) resolve2(); else reject2(new Error(e2||`pip exited ${code2}`)); });
            });
            progress.report({ increment: 100, message: '安装完成' });
            return installSubdir2;
          }
        }

        // otherwise try next candidate
        continue;
      }
    }

    if (sawVersionCandidates) {
      throw new Error('无法安装所请求的版本（已提示可用版本），安装被取消或失败。');
    }

    throw new Error('无法找到可用的 pip 命令来安装 stubs');
  });
}
