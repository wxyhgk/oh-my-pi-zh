# 面向扩展与自定义工具的 TUI 集成

本文档介绍 `packages/coding-agent` 与 `packages/tui` 当前使用的 TUI 契约,涵盖扩展 UI、自定义工具 UI 与自定义渲染器。

## 该子系统的定位

运行时分为两层:

- **渲染引擎(`packages/tui`)**:差分终端渲染器、输入分发、焦点、覆盖层、光标定位。
- **集成层(`packages/coding-agent`)**:挂载扩展/自定义工具组件,接线快捷键/主题,并恢复编辑器状态。

## 按模式划分的运行时行为

| 模式                    | `ctx.ui.custom(...)` 可用性 | 说明                                                                                                                            |
| ----------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 交互式 TUI              | 支持                        | 组件挂载在编辑器区域或覆盖层中,获得焦点,必须调用 `done(result)` 才能解析。                                                     |
| 后台/无头(headless)     | 不可交互                    | UI 上下文为空操作(`hasUI === false`)。                                                                                          |
| RPC 模式                | 不挂载                      | `custom()` 实现为不支持的 UI,返回 `undefined as never`;不要在 RPC 处理器中依赖交互式 UI。                                      |

如果你的扩展/工具可以在非交互模式下运行,请用 `ctx.hasUI` / `pi.hasUI` 做保护。

## 核心组件契约(`@oh-my-pi/pi-tui`)

`packages/tui/src/tui.ts` 定义了:

```ts
export interface Component {
  render(width: number): readonly string[];
  handleInput?(data: string): void;
  wantsKeyRelease?: boolean;
  invalidate?(): void;
  setIgnoreTight?(ignore: boolean): any;
  dispose?(): void;
}
```

渲染结果归组件所有,对调用方不可变。内容未变的组件可以(也应该)返回与上次**相同的数组引用**;内容变化时必须返回新数组。引用相等性使容器能够记忆化并避免稳定前缀的工作。原地修改先前返回数组的组件还必须实现 `RenderStablePrefix`,并报告有多少前导行保持不变。

`Focusable` 是独立的:

```ts
export interface Focusable {
  focused: boolean;
  setUseTerminalCursor?(useTerminalCursor: boolean): void;
}
```

光标行为使用 `CURSOR_MARKER`(而非 `getCursorPosition`)。获得焦点的组件在渲染文本中发出标记;`TUI` 提取它并定位硬件光标。

## 渲染约束(终端安全)

你的 `render(width)` 输出必须是终端安全的:

1. **任何行都不要故意超过 `width`**。渲染器会作为最后防线截断超宽的非图像行,但组件仍应返回宽度安全的输出。
2. **测量视觉宽度**,而非字符串长度:使用 `visibleWidth()`。
3. 使用 `truncateToWidth()` / `wrapTextWithAnsi()` **截断/换行 ANSI 感知文本**。
4. 使用 `replaceTabs()`(以及 coding-agent 渲染路径中的更高级净化器)**净化外部来源的制表符/内容**。

最小模式:

```ts
import { replaceTabs, truncateToWidth } from "@oh-my-pi/pi-tui";

render(width: number): readonly string[] {
  return this.lines.map(line => truncateToWidth(replaceTabs(line), width));
}
```

## 输入处理与快捷键

### 原始按键匹配

对导航键与组合键使用 `matchesKey(data, "...")`。

### 匹配应用快捷键动作

扩展 UI 工厂接收 `KeybindingsManager`(交互模式;内存实例携带默认绑定,而非用户的 `keybindings.yml`),因此你可以匹配动作 id,而不必硬编码按键:

```ts
if (keybindings.matches(data, "app.interrupt")) {
  done(undefined);
  return;
}
```

### 按键释放/重复事件

按键释放事件会被过滤,除非你的组件设置:

```ts
wantsKeyRelease = true;
```

如有需要,再使用 `isKeyRelease()` / `isKeyRepeat()`。

## 焦点、覆盖层与光标

- `TUI.setFocus(component)` 将输入路由到该组件。
- `TUI` 中存在覆盖层 API(`showOverlay`、`OverlayHandle`)。在交互式扩展/自定义 UI 中,`custom(..., { overlay: true })` 通过 `TUI.showOverlay(...)` 挂载你的组件;不带 `overlay` 时,它直接替换编辑器组件区域。
- 覆盖层自定义 UI 锚定在 `bottom-center`,使用终端全宽/最大高度,并在 `done(...)` 关闭流程时通过返回的覆盖层句柄移除。

## 挂载点与返回契约

## 1) 扩展 UI(`ExtensionUIContext`)

当前签名(`extensibility/extensions/types.ts`):

```ts
custom<T>(
  factory: (
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    done: (result: T) => void,
  ) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
  options?: { overlay?: boolean },
): Promise<T>
```

交互模式下的行为(`extension-ui-controller.ts`):

- 保存编辑器文本。
- 不带 `options.overlay` 时,用你的组件替换编辑器组件。
- 带 `options.overlay` 时,将你的组件作为底部居中的覆盖层挂载,而非替换编辑器。
- 聚焦你的组件。
- 在 `done(result)` 时:调用 `component.dispose?.()`,隐藏覆盖层(如有),为非覆盖层流程恢复编辑器与文本,聚焦编辑器,解析 promise。
  因此 `done(...)` 是完成所必需的。

## 2) 钩子/自定义工具 UI 上下文(运行时/类型不匹配)

`HookUIContext.custom` 的类型仍是 `(tui, theme, done)`,但交互式控制器以 `(tui, theme, keybindings, done)` 调用工厂。因此第三个运行时参数是 `KeybindingsManager`,**不是**完成回调。调用其第三个参数的三参数工厂会在运行时失败,并使自定义 UI 无法解析。

在钩子/自定义工具类型与控制器对齐之前,不要照抄类型声明中的旧式三参数示例。运行时安全的交互代码必须从第四个位置参数获取完成回调,例如使用 rest 参数适配器,并应用 `pi.hasUI` 保护流程:

```ts
const picked = await pi.ui.custom<string | undefined>(
  (...runtimeArgs: unknown[]) => {
    const done = runtimeArgs[3];
    if (typeof done !== "function") {
      throw new Error(
        "Interactive custom UI completion callback is unavailable",
      );
    }
    return new MyPickerComponent(
      done as (value: string | undefined) => void,
      signal,
    );
  },
);
```

这是针对当前实现的兼容性变通方案,不是稳定的四参数钩子类型。上文描述的 `ExtensionUIContext.custom` 才是有支持的四个参数契约。

## 3) 自定义工具调用/结果渲染器

自定义工具与扩展工具可以从以下函数返回组件:

- `renderCall(args, options, theme)`
- `renderResult(result, options, theme, args?)`

`options` 当前包含:

- `expanded: boolean`
- `isPartial: boolean`
- `spinnerFrame?: number`

这些渲染器由 `ToolExecutionComponent` 挂载。

## 生命周期与取消

- `dispose()` 在类型层面是可选的,但当你拥有定时器、子进程、监视器、套接字或覆盖层时应实现它。它必须是幂等的:容器会传播销毁,重置/移除路径可能汇合。
- `done(...)` 应在你的组件流程中恰好调用一次。
- 对于可取消的长时间运行 UI,将 `CancellableLoader` 与 `AbortSignal` 配对,并从 `onAbort` 调用 `done(...)`。

取消模式示例:

```ts
const loader = new CancellableLoader(
  tui,
  theme.fg("accent"),
  theme.fg("muted"),
  "Working...",
);
loader.onAbort = () => done(undefined);
void doWork(loader.signal).then((result) => done(result));
return loader;
```

## 真实的自定义组件示例(扩展命令)

```ts
import type { Component } from "@oh-my-pi/pi-tui";
import {
  SelectList,
  matchesKey,
  replaceTabs,
  truncateToWidth,
} from "@oh-my-pi/pi-tui";
import {
  getSelectListTheme,
  type ExtensionAPI,
} from "@oh-my-pi/pi-coding-agent";

class Picker implements Component {
  list: SelectList;
  keybindings: any;
  done: (value: string | undefined) => void;

  constructor(
    items: Array<{ value: string; label: string }>,
    keybindings: any,
    done: (value: string | undefined) => void,
  ) {
    this.list = new SelectList(items, 8, getSelectListTheme());
    this.keybindings = keybindings;
    this.done = done;
    this.list.onSelect = (item) => this.done(item.value);
    this.list.onCancel = () => this.done(undefined);
  }

  handleInput(data: string): void {
    if (this.keybindings.matches(data, "app.interrupt")) {
      this.done(undefined);
      return;
    }
    this.list.handleInput(data);
  }

  render(width: number): readonly string[] {
    return this.list
      .render(width)
      .map((line) => truncateToWidth(replaceTabs(line), width));
  }

  invalidate(): void {
    this.list.invalidate();
  }
}

export default function extension(pi: ExtensionAPI): void {
  pi.registerCommand("pick-model", {
    description: "Pick a model profile",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;

      const selected = await ctx.ui.custom<string | undefined>(
        (tui, theme, keybindings, done) => {
          const items = [
            { value: "fast", label: theme.fg("accent", "Fast") },
            { value: "balanced", label: "Balanced" },
            { value: "quality", label: "Quality" },
          ];
          return new Picker(items, keybindings, done);
        },
      );

      if (selected) ctx.ui.notify(`Selected profile: ${selected}`, "info");
    },
  });
}
```

## 关键实现文件

- `packages/tui/src/tui.ts` — `Component`、`Focusable`、光标标记、焦点、覆盖层、输入分发。
- `packages/tui/src/utils.ts` — 宽度/截断/净化原语。
- `packages/tui/src/keys.ts` / `keybindings.ts` — 按键解析与可配置动作映射。
- `packages/coding-agent/src/modes/controllers/extension-ui-controller.ts` — 扩展/钩子/自定义工具 UI 的交互式挂载/卸载。
- `packages/coding-agent/src/extensibility/extensions/types.ts` — 扩展 UI 与渲染器契约。
- `packages/coding-agent/src/extensibility/hooks/types.ts` — 钩子 UI 契约(旧式 custom 签名)。
- `packages/coding-agent/src/extensibility/custom-tools/types.ts` — 自定义工具执行/渲染契约。
- `packages/coding-agent/src/modes/components/tool-execution.ts` — 挂载 `renderCall`/`renderResult` 组件与部分状态选项。
- `packages/coding-agent/src/tools/context.ts` — 工具 UI 上下文传播(`hasUI`、`ui`)。
