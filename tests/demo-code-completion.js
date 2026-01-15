#!/usr/bin/env node

/**
 * 代码补全功能演示脚本
 * 展示如何使用代码补全功能
 */

const fs = require('fs');
const path = require('path');

console.log('🎯 MicroPython 代码补全功能演示\n');

// 1. 显示可用的模块
console.log('📚 可用的 MicroPython 模块:');
const defaultPath = path.join(__dirname, 'code_completion', 'default');
const modules = fs.readdirSync(defaultPath)
    .filter(file => file.endsWith('.py'))
    .map(file => file.replace('.py', ''))
    .sort();

console.log(`共 ${modules.length} 个模块:`);
modules.forEach((module, index) => {
    process.stdout.write(`${module.padEnd(15)}`);
    if ((index + 1) % 6 === 0) console.log();
});
console.log('\n');

// 2. 展示一些常用模块的示例
console.log('🔍 常用模块示例:\n');

const examples = [
    { module: 'machine', description: '硬件控制模块' },
    { module: 'network', description: '网络模块' },
    { module: 'time', description: '时间模块' },
    { module: 'json', description: 'JSON 处理模块' }
];

examples.forEach(({ module, description }) => {
    const modulePath = path.join(defaultPath, `${module}.py`);
    if (fs.existsSync(modulePath)) {
        const content = fs.readFileSync(modulePath, 'utf8');
        const lines = content.split('\n').slice(0, 5); // 前5行

        console.log(`📖 ${module} - ${description}`);
        console.log('   示例内容:');
        lines.forEach(line => {
            if (line.trim()) console.log(`     ${line}`);
        });
        console.log();
    }
});

// 3. 展示多语言支持
console.log('🌍 多语言支持:');
const zhPath = path.join(__dirname, 'code_completion', 'zh-cn');
const hasZh = fs.existsSync(zhPath);

if (hasZh) {
    const zhModules = fs.readdirSync(zhPath)
        .filter(file => file.endsWith('.py'))
        .length;

    console.log(`✅ 支持中文文档 (${zhModules} 个模块)`);
    console.log('   VS Code 语言设置为中文时将自动使用中文文档');
} else {
    console.log('❌ 未找到中文文档');
}

// 4. 配置说明
console.log('\n⚙️ 配置说明:');
console.log('- microPythonWorkBench.enableCodeCompletion: 启用/禁用代码补全');
console.log('- microPythonWorkBench.enableMultiLanguageDocs: 启用多语言文档');
console.log('- 自动检测: 当检测到 MicroPython 项目时自动启用');
console.log('- 手动切换: 使用命令面板中的 "切换代码补全" 命令');

console.log('\n🎉 演示完成！代码补全功能已准备就绪。');