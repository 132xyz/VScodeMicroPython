# VS Code MicroPython 扩展 - 单元测试

本文档描述了为 VS Code MicroPython 扩展建立的单元测试基础设施和测试内容。

## 测试基础设施

### 已安装的依赖
- **Jest**: 测试框架
- **@types/jest**: Jest 的 TypeScript 类型定义
- **ts-jest**: Jest 的 TypeScript 预设

### 配置
- `jest.config.js`: Jest 配置文件
- `tsconfig.json`: 添加了 Jest 类型支持
- `package.json`: 添加了 `test` 和 `test:watch` 脚本

### Mock 设置
- `tests/__mocks__/vscode.ts`: VS Code API 的模拟
- `tests/setup.ts`: Jest 设置文件，包含必要的 mocks

## 测试内容

### 高优先级测试 - 已实施

#### 1. `mpremoteCommands.isVersionCompatible()` 函数

**测试文件**: `tests/mpremoteCommands.test.ts`

**测试覆盖**:
- ✅ 接受版本 1.20.0 及以上
- ✅ 拒绝版本低于 1.20.0
- ✅ 处理不完整的版本号
- ✅ 处理无效的版本字符串
- ✅ 正确处理边界情况

**测试用例**:
```typescript
// 接受的版本
'1.20.0', '1.20.1', '1.21.0', '2.0.0', '2.1.5'

// 拒绝的版本
'1.19.9', '1.19.0', '1.10.0', '0.9.0'

// 不完整的版本号
'1.20' (接受), '2.0' (接受), '1' (拒绝), '2' (拒绝), '' (拒绝)

// 无效的版本字符串
'invalid', '1.invalid.0', 'a.b.c'
```

## 运行测试

### 运行所有测试
```bash
npm test
```

### 运行测试并生成覆盖率报告
```bash
npx jest --coverage
```

### 监听模式运行测试
```bash
npm run test:watch
```

## 测试覆盖率目标

根据项目分析，以下是测试覆盖率目标：

- **sync.ts**: 95%+ (核心业务逻辑)
- **路径转换函数**: 100% (简单但关键)
- **pythonInterpreter.ts**: 80%+ (工具函数)
- **mpremoteCommands.ts**: 70%+ (安装逻辑)

## 后续扩展

### 中优先级测试内容
- `pythonInterpreter.ts` 中的 `getFallbackPythonPaths()` 和 `validatePythonPath()` 函数
- `mpremoteCommands.ts` 中的其他纯函数

### 低优先级测试内容
- 类型和接口验证
- 配置和常量验证

## 测试策略

1. **纯函数优先**: 优先测试不依赖外部状态的纯函数
2. **Mock 外部依赖**: 对 VS Code API、文件系统、子进程等进行适当 mock
3. **边界情况覆盖**: 确保测试覆盖正常情况、边界情况和错误情况
4. **可维护性**: 测试代码应该清晰、易于理解和维护

## 贡献

添加新测试时，请遵循以下原则：

1. 为每个测试用例提供清晰的描述
2. 使用有意义的断言
3. 保持测试独立性
4. 更新此文档以反映新的测试内容