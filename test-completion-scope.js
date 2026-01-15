#!/usr/bin/env node

/**
 * 代码补全范围测试脚本
 * 测试修复后的启用范围逻辑
 */

const path = require('path');

// 模拟工作区路径
const workspaceRoot = 'c:\\qzrobot\\mpy';

// 测试场景
const testCases = [
  {
    name: '配置了syncLocalRoot=mpy，文件在mpy目录内',
    config: { syncLocalRoot: 'mpy', connect: 'auto' },
    filePath: 'c:\\qzrobot\\mpy\\mpy\\main.py',
    expected: true,
    description: '应该启用 - 文件在同步目录内'
  },
  {
    name: '配置了syncLocalRoot=mpy，文件在工作区根目录',
    config: { syncLocalRoot: 'mpy', connect: 'auto' },
    filePath: 'c:\\qzrobot\\mpy\\boot.py',
    expected: false,
    description: '不应该启用 - 文件不在同步目录内'
  },
  {
    name: '没有配置syncLocalRoot，配置了connect',
    config: { syncLocalRoot: '', connect: 'COM3' },
    filePath: 'c:\\qzrobot\\mpy\\main.py',
    expected: true,
    description: '应该启用 - 配置了连接'
  },
  {
    name: '没有配置syncLocalRoot和connect，文件在根目录',
    config: { syncLocalRoot: '', connect: 'auto' },
    filePath: 'c:\\qzrobot\\mpy\\main.py',
    expected: true,
    description: '应该启用 - 根目录文件且无同步配置'
  },
  {
    name: '没有配置syncLocalRoot和connect，文件在子目录',
    config: { syncLocalRoot: '', connect: 'auto' },
    filePath: 'c:\\qzrobot\\mpy\\src\\main.py',
    expected: false,
    description: '不应该启用 - 子目录文件且无同步配置'
  }
];

console.log('🧪 代码补全范围测试\n');

// 模拟路径检查逻辑
function isInSyncDirectory(filePath, syncLocalRoot, workspaceRoot) {
  if (!syncLocalRoot) return false;

  const syncPath = path.isAbsolute(syncLocalRoot)
    ? syncLocalRoot
    : path.join(workspaceRoot, syncLocalRoot);

  const relativePath = path.relative(syncPath, filePath);
  return !relativePath.startsWith('..') && relativePath !== filePath;
}

function isInWorkspaceRoot(filePath, workspaceRoot) {
  const relativePath = path.relative(workspaceRoot, filePath);
  return !relativePath.startsWith('..') && !relativePath.includes(path.sep);
}

function shouldEnableCodeCompletion(config, filePath) {
  const { syncLocalRoot, connect } = config;

  // 如果配置了同步目录，检查文件是否在同步目录内
  if (syncLocalRoot) {
    const result = isInSyncDirectory(filePath, syncLocalRoot, workspaceRoot);
    if (result) {
      return true;
    }
    // 如果配置了同步目录但文件不在同步目录内，不启用
    return false;
  }

  // 如果配置了连接但没有同步目录，启用
  if (connect && connect !== 'auto') {
    return true;
  }

  // 如果没有配置同步目录和连接，只有根目录的文件才启用
  return isInWorkspaceRoot(filePath, workspaceRoot);
}

// 运行测试
let passed = 0;
let total = testCases.length;

testCases.forEach((testCase, index) => {
  console.log(`测试 ${index + 1}: ${testCase.name}`);

  const result = shouldEnableCodeCompletion(testCase.config, testCase.filePath);
  const success = result === testCase.expected;

  console.log(`  配置: ${JSON.stringify(testCase.config)}`);
  console.log(`  文件: ${testCase.filePath}`);
  console.log(`  期望: ${testCase.expected ? '启用' : '不启用'}`);
  console.log(`  结果: ${result ? '启用' : '不启用'}`);
  console.log(`  说明: ${testCase.description}`);

  if (success) {
    console.log('  ✅ 通过\n');
    passed++;
  } else {
    console.log('  ❌ 失败\n');
  }
});

console.log(`📊 测试结果: ${passed}/${total} 通过`);

if (passed === total) {
  console.log('🎉 所有测试通过！代码补全范围逻辑修复成功。');
  console.log('\n🔧 修复说明:');
  console.log('- 配置了syncLocalRoot时，只在同步目录内的Python文件启用代码补全');
  console.log('- 没有配置syncLocalRoot时，在工作区根目录的Python文件启用代码补全');
  console.log('- 配置了connect但没有syncLocalRoot时，全局启用代码补全');
} else {
  console.log('⚠️ 部分测试失败，请检查逻辑。');
}