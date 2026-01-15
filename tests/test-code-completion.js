#!/usr/bin/env node

/**
 * 简单的代码补全功能测试脚本
 * 用于验证基本功能是否正常工作
 */

const path = require('path');

// 模拟扩展路径
const extensionPath = __dirname;

// 测试stub文件路径解析
function testStubPathResolution() {
    console.log('🧪 测试 Stub 文件路径解析...');

    const defaultPath = path.join(extensionPath, 'code_completion', 'default');
    const zhCnPath = path.join(extensionPath, 'code_completion', 'zh-cn');

    console.log('默认路径:', defaultPath);
    console.log('中文路径:', zhCnPath);

    // 检查路径是否存在
    const fs = require('fs');
    const defaultExists = fs.existsSync(defaultPath);
    const zhCnExists = fs.existsSync(zhCnPath);

    console.log('默认路径存在:', defaultExists);
    console.log('中文路径存在:', zhCnExists);

    if (defaultExists && zhCnExists) {
        console.log('✅ Stub 文件路径解析测试通过');
        return true;
    } else {
        console.log('❌ Stub 文件路径解析测试失败');
        return false;
    }
}

// 测试本地化键
function testLocalizationKeys() {
    console.log('\n🧪 测试本地化键...');

    try {
        const enLocale = require('./package.nls.json');
        const zhLocale = require('./package.nls.zh-cn.json');

        const testKeys = [
            'configuration.enableCodeCompletion.description',
            'commands.toggleCodeCompletion.title',
            'messages.codeCompletionEnabled'
        ];

        let allKeysPresent = true;

        for (const key of testKeys) {
            if (!enLocale[key]) {
                console.log(`❌ 英文本地化缺少键: ${key}`);
                allKeysPresent = false;
            }
            if (!zhLocale[key]) {
                console.log(`❌ 中文本地化缺少键: ${key}`);
                allKeysPresent = false;
            }
        }

        if (allKeysPresent) {
            console.log('✅ 本地化键测试通过');
            console.log('示例英文:', enLocale['messages.codeCompletionEnabled']);
            console.log('示例中文:', zhLocale['messages.codeCompletionEnabled']);
            return true;
        } else {
            console.log('❌ 本地化键测试失败');
            return false;
        }
    } catch (error) {
        console.log('❌ 本地化键测试出错:', error.message);
        return false;
    }
}

// 测试配置结构
function testConfigurationStructure() {
    console.log('\n🧪 测试配置结构...');

    try {
        const packageJson = require('./package.json');
        const contributes = packageJson.contributes;

        // 检查配置项
        const configProperties = contributes.configuration.properties;
        const requiredConfigs = [
            'microPythonWorkBench.enableCodeCompletion',
            'microPythonWorkBench.enableMultiLanguageDocs'
        ];

        let configValid = true;
        for (const config of requiredConfigs) {
            if (!configProperties[config]) {
                console.log(`❌ 缺少配置项: ${config}`);
                configValid = false;
            }
        }

        // 检查命令
        const commands = contributes.commands;
        const requiredCommands = [
            'microPythonWorkBench.toggleCodeCompletion'
        ];

        let commandsValid = true;
        for (const cmd of requiredCommands) {
            const found = commands.some(c => c.command === cmd);
            if (!found) {
                console.log(`❌ 缺少命令: ${cmd}`);
                commandsValid = false;
            }
        }

        // 检查推荐扩展
        const recommends = packageJson.recommends || [];
        const hasPylance = recommends.includes('ms-python.vscode-pylance');

        if (!hasPylance) {
            console.log('❌ 缺少 Pylance 推荐扩展');
            configValid = false;
        }

        if (configValid && commandsValid) {
            console.log('✅ 配置结构测试通过');
            return true;
        } else {
            console.log('❌ 配置结构测试失败');
            return false;
        }
    } catch (error) {
        console.log('❌ 配置结构测试出错:', error.message);
        return false;
    }
}

// 主测试函数
async function runTests() {
    console.log('🚀 开始代码补全功能测试\n');

    const results = [
        testStubPathResolution(),
        testLocalizationKeys(),
        testConfigurationStructure()
    ];

    const passed = results.filter(r => r).length;
    const total = results.length;

    console.log(`\n📊 测试结果: ${passed}/${total} 通过`);

    if (passed === total) {
        console.log('🎉 所有测试通过！代码补全功能已成功集成。');
        process.exit(0);
    } else {
        console.log('⚠️ 部分测试失败，请检查上述错误信息。');
        process.exit(1);
    }
}

// 运行测试
if (require.main === module) {
    runTests().catch(error => {
        console.error('测试运行出错:', error);
        process.exit(1);
    });
}

module.exports = { runTests, testStubPathResolution, testLocalizationKeys, testConfigurationStructure };