# 交付说明：校验层处理指令（PI）位置判定错位修复

## 一、问题现象

采集管道的入库前置校验层（`XMLValidator.validate`）与下游结构化解析入口
（`XMLParser.parse`）对同一段抓取报文的处理指令（Processing Instruction，形如
`<?target ...?>`）给出互相矛盾的结论：

- 正文中间 / 根节点之后出现的**未闭合处理指令**（缺少结尾 `?>`），校验层判为
  合法直接放行入库；
- 同一报文进入下游结构化解析时，解析层抛出 `Pi Tag is not closed.`；
- 若未闭合 PI 出现在某个元素内部，校验层还会把它误报成 `Unclosed tag '<根元素>'`，
  排障方向被引到标签闭合而不是 PI 本身，需要从下游反向排查数日才能回到校验层。

## 二、根因结论

根因位于 `src/validator.js` 的处理指令读取函数 `readPI` 及其两个调用点，共三处缺陷：

1. **未闭合 PI 不报错（直接放行的根因）。**
   原 `readPI` 的扫描循环在找不到结尾 `?>` 时会直接走到字符串末尾并正常返回游标，
   函数没有任何"读到 EOF 仍未闭合"的错误分支。于是顶层未闭合 PI 被静默跳过、
   报文整体通过校验；解析层 `OrderedObjParser` 则通过 `findClosingIndex(..., "?>",
   ..., "Pi Tag is not closed.")` 显式抛错，形成"一放一拦"。

2. **调用点游标错位，PI 目标名整体少读一个字符。**
   - 顶层调用点先执行 `i += 2`（游标已落在 `<?` 之后的目标名首字符），再把 `i`
     传给 `readPI`，语义本身正确；
   - 但元素文本区内的调用点写成 `readPI(xmlData, ++i)`：进入分支时 `i` 指向 `<`，
     前置自增只把游标推到 `?`，比目标名首字符少一位。
   两个入口对同一套 PI 逻辑传入了不同基准的游标，位置口径本身就不统一。

3. **错位 `<?xml` 声明的检测条件失效。**
   原代码用 `if (i > 5 && tagname === 'xml')` 判定声明位置，其中残留的 `i > 5`
   硬编码条件没有任何语义依据：短报文（如 `<root/><?xml?>`）里 `i` 永远到不了 5，
   正文中间的 `<?xml` 声明因此全部漏判；叠加缺陷 2 的游标错位，`tagname` 取到的是
   少一位的字符串，连长报文里的判定也不可靠。

## 三、修复方案（统一校验层与解析层口径）

仅改动 `src/validator.js`：

1. 统一两个调用点的入参约定：`readPI` 一律接收"PI 目标名首字符（即 `<?` 之后）"
   的索引。顶层调用点传 `i`（`i += 2` 之后）；文本区调用点由 `++i` 修正为 `i + 2`。
2. 重写 `readPI`，拆成"读目标名 → 定位闭合符 `?>`"两段：
   - 扫描到字符串末尾仍未找到 `?>` 时，返回 `InvalidXml` 错误
     `Pi Tag '<目标名>' is not closed.`，错误位置指向 PI 起始处（含行号、列号），
     与解析层的 `Pi Tag is not closed.` 规则对齐；
   - `xml` 声明只允许出现在文档起始位置（BOM 剥除后目标名索引恒为 2），其余位置
     一律在声明自身位置报 `XML declaration allowed only at the start of the
     document.`，删除无依据的 `i > 5` 条件。
3. BOM 处理保持原逻辑：剥除 BOM 后字符串重新从 0 编号，文档起始声明的目标名索引
   固定为 2，头部合法样本（含带 BOM 样本）不受影响。

## 四、口径对照（修复后实测）

| 报文形态 | 校验层 | 解析层 |
| --- | --- | --- |
| 头部合法 `<?xml ...?>` 声明（含 BOM） | 放行 | 正常解析 |
| 头部 / 正文内合法 PI（`<?mso?>` 等） | 放行 | 正常解析 |
| 元素文本区未闭合 PI | `Pi Tag 'pi' is not closed.`（指明行列与目标名） | `Pi Tag is not closed.` |
| 根节点闭合后顶层未闭合 PI | 同上，位置指向该 PI | 同上 |
| 文档头部未闭合 `<?xml ...` | `Pi Tag 'xml' is not closed.` | `Pi Tag is not closed.` |
| 正文中间错位 `<?xml ...?>` | `XML declaration allowed only at the start of the document.` | 校验闸门拦截 |

## 五、测试

- 新增 `spec/pi_position_validation_spec.js`，按"位置形态 × 两个入口"补齐对照测试：
  - 位置形态：文档头部（含 BOM）、prolog、元素文本区、根节点闭合后顶层、多行、
    CRLF；
  - 两入口：`XMLValidator.validate` 与 `XMLParser.parse(xml, true)` 校验闸门，并对
    解析层独立解析（不带校验闸门）补充同口径断言；
  - 合法样本断言两入口均放行，未闭合 / 错位样本断言错误码、文案、行号、列号与
    PI 目标名。
- 全量既有测试保持通过：`388 specs, 0 failures`（其中 2 个 pending 为仓库既有），
  含 `validator_utf8_with_BOM_spec.js` BOM 专项与 `pi_spec.js`、`data_spec.js` 中
  既有的 `Pi Tag is not closed.` 断言。
