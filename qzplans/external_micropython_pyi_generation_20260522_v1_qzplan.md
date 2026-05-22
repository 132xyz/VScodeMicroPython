# 外部 MicroPython C 模块 pyi 生成计划

- 项目: 外部 MicroPython 模块类型补全生成
- 日期: 2026-05-22
- 版本: v1
- 状态: 仅分析与计划，未开始批量生成 pyi

## 1. 目标设定

### 主目标

基于三个外部仓库中的 C 模块实现，逐模块梳理公共 API，并把可用于 VS Code / Pylance 代码提示的 pyi 文件生成到 E:\xm\github\my_custom\modules\pyi。

### 子目标

1. 为 camera 模块生成以源码为准、兼容现有 typings 习惯的 camera.pyi 与 acamera.pyi。
2. 为 ulab 模块按实际导出树生成包结构化 stubs，包括根模块、numpy、scipy、user、utils 及其公开子模块。
3. 为 sh8601 模块生成单文件 stub，覆盖类、构造参数、方法、模块函数与常量语义。
4. 对每个函数尽量给出参数类型、可选参数、关键字参数与返回值类型；无法确定时保守使用 object、Any、Buffer 等宽类型并注明原因。
5. 生成结果应保持目录结构清晰，便于后续继续增量维护。

## 2. 现有参考与已确认事实

### 2.1 camera 仓库

1. 目标仓库中不存在用户描述的 camera_pyi 目录，当前可直接复用的类型参考来自 typings 下的现有 stub。
2. camera 模块的真实导出由 src/modcamera_api.c、src/modcamera.c、src/modcamera.h 决定。
3. 现有 typings 已覆盖大部分属性和方法，但仍需要以 C 导出表为准逐项校对。
4. acamera.pyi 当前表现为对 camera.Camera 的异步包装扩展，需确认是否保持此设计不变。

### 2.2 ulab 仓库

1. 顶层模块名为 ulab，根模块导出 __version__、dtype，以及 numpy、scipy、user、utils 等子模块。
2. ulab.numpy 公开了 ndarray、dtype 常量、数学常量、创建函数、比较函数、统计函数、向量函数，以及 fft、linalg、random 子模块。
3. ulab.scipy 公开了 integrate、linalg、optimize、signal、special 子模块。
4. ulab.user 当前至少公开 square。
5. ulab.utils 当前至少公开 from_int16_buffer、from_uint16_buffer、from_int32_buffer、from_uint32_buffer、spectrogram 等函数。
6. ulab 的大量 API 受编译宏控制，实际设备可见接口可能是源码超集的一个子集。

### 2.3 sh8601 模块

1. 模块名为 sh8601。
2. 公开的模块级对象目前有 version 和类 QSPIPanel。
3. QSPIPanel 构造参数明确，包括必需的 sck、d0、d1、d2、d3、cs、width、height，以及可选的 rst、freq。
4. 对外方法目前包括 init、deinit、on、off、brightness、invert、rotation、blit、fill、read_reg、width、height。
5. width 与 height 在 C 层是零参函数风格导出，不是 @property；stub 需要按实际可调用形式表达。

### 2.4 输出目录

1. 目标输出目录 E:\xm\github\my_custom\modules\pyi 当前为空。
2. 该目录在当前环境中可访问，适合直接生成目标 pyi 树。

## 3. 需求分析与待确认点

### 已明确需求

1. 需要逐个函数分析，而不是只给出粗略的模块级骨架。
2. 需要把结果直接生成到目标 pyi 目录，而不是仅输出建议文本。
3. 需要覆盖三个来源：camera、ulab、sh8601。

### 仍需你确认的关键策略

1. ulab 是否按源码可见公共 API 生成“上游超集 stub”。
   - 推荐方案: 生成源码超集，并对明显受宏控制的接口在注释中标记“具体板端可能未启用”。
   - 备选方案: 若你要的是某个特定固件的精确子集，则还需要该固件对应的配置头或编译产物作为约束。
2. camera 是否保留现有 typings 的文档字符串与结构风格。
   - 推荐方案: 以 C 导出为准，尽量沿用现有 typings 的命名、注释和布局，减少行为漂移。
3. 是否需要同时生成一个简短的 README 或 manifest 说明这些 pyi 的来源和生成日期。
   - 推荐方案: 至少生成一个说明文件，避免后续不知道哪些文件来自哪次提取。

## 4. 架构设计

### 4.1 工作分层

1. API 盘点层
   - 从 C 文件中的模块 globals table、locals_dict_table、类型定义、函数宏与注释中提取公共接口。
   - 目标是得到“模块 -> 类 -> 方法/属性/常量”结构化清单。

2. 签名推断层
   - 根据 MP_DEFINE_CONST_FUN_OBJ_*、mp_arg_t、mp_arg_parse_all_kw_array、mp_get_buffer_raise 等模式推断参数和返回类型。
   - 对无法精准判断的参数，优先保守宽类型而不是误报窄类型。

3. Stub 组装层
   - 统一生成 import、类型别名、类定义、函数定义、Final 常量、__all__ 等内容。
   - 保持同一模块内的风格一致，避免一个文件里混用多种写法。

4. 验证层
   - 校验 pyi 目录结构是否完整。
   - 校验语法层面无明显错误。
   - 必要时做最小导入模拟或静态检查。

### 4.2 输出目录结构

计划输出如下文件:

1. E:\xm\github\my_custom\modules\pyi\camera.pyi
2. E:\xm\github\my_custom\modules\pyi\acamera.pyi
3. E:\xm\github\my_custom\modules\pyi\sh8601.pyi
4. E:\xm\github\my_custom\modules\pyi\ulab\__init__.pyi
5. E:\xm\github\my_custom\modules\pyi\ulab\numpy\__init__.pyi
6. E:\xm\github\my_custom\modules\pyi\ulab\numpy\fft\__init__.pyi
7. E:\xm\github\my_custom\modules\pyi\ulab\numpy\linalg\__init__.pyi
8. E:\xm\github\my_custom\modules\pyi\ulab\numpy\random\__init__.pyi
9. E:\xm\github\my_custom\modules\pyi\ulab\scipy\__init__.pyi
10. E:\xm\github\my_custom\modules\pyi\ulab\scipy\integrate\__init__.pyi
11. E:\xm\github\my_custom\modules\pyi\ulab\scipy\linalg\__init__.pyi
12. E:\xm\github\my_custom\modules\pyi\ulab\scipy\optimize\__init__.pyi
13. E:\xm\github\my_custom\modules\pyi\ulab\scipy\signal\__init__.pyi
14. E:\xm\github\my_custom\modules\pyi\ulab\scipy\special\__init__.pyi
15. E:\xm\github\my_custom\modules\pyi\ulab\user\__init__.pyi
16. E:\xm\github\my_custom\modules\pyi\ulab\utils\__init__.pyi

说明:

1. 仅为真实导出的公开模块生成文件，不为纯内部目录或未挂接到 globals table 的实现细分目录单独生成 pyi。
2. 若后续确认某些子模块在目标固件中也直接暴露，再增补对应文件。

## 5. 具体实现内容

### 5.1 camera 模块生成策略

输出内容:

1. 枚举风格类: GainCeiling、GrabMode、PixelFormat、FrameSize。
2. Camera 类:
   - 构造函数关键字参数
   - 读写属性与只读属性
   - capture、frame_available、free_buffer、reconfigure、init、deinit
   - 兼容旧接口的 get_* / set_* 方法
   - __enter__、__exit__、__del__ 的上下文管理与销毁语义
3. acamera.Camera 对 camera.Camera 的异步扩展。

已发现的重点差异:

1. capture 在 C 层存在返回 None 的分支，不能直接固定为 memoryview。
2. data_pins 在 C 层允许 list 或 bytearray，现有 stub 偏窄。
3. 真实导出包含大量兼容性的 get_* / set_* 方法，需核对现有 typings 是否完整覆盖。
4. 模块级 Version 为条件编译导出，若没有可靠宏值，则 stub 中不强行固定常驻。

### 5.2 ulab 模块生成策略

输出内容:

1. ulab 根模块:
   - __version__
   - dtype
   - numpy、scipy、user、utils
2. ulab.numpy:
   - ndarray 类
   - dtype 常量
   - 核心函数
   - fft、linalg、random 子模块
3. ulab.scipy:
   - integrate、linalg、optimize、signal、special 子模块
4. ulab.user:
   - 当前已识别公开函数 square
5. ulab.utils:
   - 缓冲区转换函数与 spectrogram 等工具函数

推断原则:

1. 函数签名优先从 mp_arg_t 推断关键字参数。
2. 一元、二元、变参数函数从 MP_DEFINE_CONST_FUN_OBJ_* 的宏类型推断调用方式。
3. ndarray、dtype、flatiter 等类型优先以最小可用声明表达，不先过度模拟 CPython numpy 的复杂协议。
4. 对宏开关控制的 API，默认按源码超集写入，并在必要处添加简短注释提示“可能依构建选项裁剪”。

### 5.3 sh8601 模块生成策略

输出内容:

1. 模块函数 version() -> str。
2. QSPIPanel 类:
   - 精确构造参数
   - init、deinit、on、off
   - brightness、invert、rotation
   - blit、fill、read_reg
   - width()、height() 的方法式调用

推断原则:

1. blit 的最后一个参数按缓冲区协议建模，而不是限定为 bytes。
2. rotation 只接受 0、90、180、270，stub 可先用 int 表达，必要时补 Literal。
3. brightness 取值实际按 0..255 处理，stub 可用 int 并在文档字符串说明范围。

### 5.4 生成流程伪代码

```text
for each target module source:
    locate module globals table
    locate exported type locals_dict_table
    map each exported symbol to its C implementation
    infer signature from MP_DEFINE_CONST_FUN_OBJ_* or mp_arg_t arrays
    infer return type from constructors, bool/int builders, memoryview/buffer builders
    merge with any existing upstream stub when available
    emit normalized pyi text
    write file into target pyi tree

validate generated files:
    ensure package directories exist
    ensure __init__.pyi files are present where needed
    ensure pyi syntax is valid
    spot-check a few representative modules
```

## 6. 注意事项与潜在挑战

1. ulab 是最复杂部分，因为大量接口通过宏裁剪，且目录多、函数多、部分函数签名较长。
2. camera 仓库已有现成 typings，不能盲目重写；要以源码为真值、以现有 stub 为格式参考。
3. sh8601 相对简单，但 width 和 height 看起来像属性名，实际是零参方法，stub 必须与真实调用方式一致。
4. 目标输出目录在当前工作区之外，后续生成时只能做绝对路径写入和有限验证，不能像工作区文件那样直接建立跳转引用。
5. 如果后续需要把这些 pyi 纳入某个具体项目的 stubPath，还要再确认目录根应该指向 pyi 还是其上层目录。

## 7. 验收标准

1. 目标目录中生成完整的 pyi 树，文件路径与计划一致。
2. 每个文件至少包含模块级公共 API，不留空壳模块。
3. 代表性函数的参数个数、关键字参数与返回值不明显偏离真实实现。
4. camera 与 sh8601 的类接口可以直接用于编辑器补全。
5. ulab 的根模块、numpy、scipy、user、utils 与主要子模块之间可正确跳转和补全。

## 8. 下一阶段执行顺序

1. 先完成 camera，因为已有 upstream typings 可校对，收敛最快。
2. 再完成 sh8601，因为模块小、可快速形成稳定模板。
3. 最后处理 ulab，并按根模块 -> numpy/scipy -> 细分子模块顺序推进。
4. 每完成一个模块族就做一次本地语法检查，避免最后集中返工。

## 9. 当前建议

建议你先确认以下执行基线后再开始真正生成:

1. ulab 按“源码超集 stub”生成，而不是绑定某个固件精确裁剪结果。
2. camera 以 C 源码为准，但尽量保留现有 typings 的注释与结构风格。
3. 允许我在输出目录中额外创建少量说明文件，以记录生成时间和来源。