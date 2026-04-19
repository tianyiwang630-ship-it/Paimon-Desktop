# openpyxl Troubleshooting Guide

> 常见踩坑经验与排障参考。遇到 openpyxl 报错时优先查阅本文档。

---

## 一、合并单元格（MergedCell）陷阱

### 1.1 问题现象

```python
ws.merge_cells('A4:A5')
ws['A5'] = ''          # ❌ AttributeError: 'MergedCell' value is read-only
ws['A5'].fill = fill   # ❌ TypeError: Fill() takes no arguments
ws['A5'].font = font   # ❌ 同理不可写
```

### 1.2 根因

`merge_cells()` 执行后，合并区域中**左上角以外的所有单元格**变为 `MergedCell` 对象：
- `MergedCell` 是只读的，不能设置 `.value`、`.fill`、`.font`、`.border` 等任何属性
- 尝试写入不会在赋值时报错，而是在 `wb.save()` 时才抛出 `TypeError: expected Fill` 等晦涩错误，导致难以定位

### 1.3 正确做法：先样式，后合并

```python
# ✅ Step 1: 先给合并区域内所有单元格设置好样式
for r in range(r1, r2 + 1):
    for c in range(c1, c2 + 1):
        cell = ws.cell(row=r, column=c)
        cell.fill = fill
        cell.border = border
        cell.alignment = alignment

# ✅ Step 2: 最后再合并
ws.merge_cells(start_row=r1, start_column=c1, end_row=r2, end_column=c2)

# ✅ Step 3: 只操作左上角单元格的值
ws.cell(row=r1, column=c1).value = "标题内容"
```

### 1.4 注意事项

- 合并前不要对子单元格赋 `.value`，否则合并后变成 MergedCell 就无法更改
- 如果需要"合并后改值"，先 `unmerge` → 改值 → 重新 `merge`，但不推荐这种模式
- `wb.save()` 才是真正的验收点，不要因为没有即时报错就认为没问题

---

## 二、代码执行策略

### 2.1 不要内联长代码

```bash
# ❌ python -c "..." 内联执行长代码：引号嵌套易错，换行难处理
python -c "from openpyxl import Workbook; wb = Workbook(); ..."

# ✅ 先写 .py 文件，再用绝对路径调用 python 执行
/path/to/python.exe script.py
```

### 2.2 路径格式

在 Bash 环境中操作 Windows 路径时：

```bash
# ❌ 反斜杠在 Bash 中会被当作转义符
cd D:\path\to\dir

# ✅ 一律使用正斜杠，Bash 和 Windows 均兼容
cd D:/path/to/dir
```

### 2.3 Python 调用方式

使用打包的 Python 运行时的绝对路径，不要依赖 `python` 或 `python3` 命令别名。

---

## 三、经验速查表

| 类别 | 常见坑 | 对策 |
|------|--------|------|
| 合并单元格 | MergedCell 只读 | 先设样式再合并，只写左上角 |
| 合并单元格 | save() 时才暴露错误 | 每次修改后尽早 save 验证 |
| 路径 | Bash 中反斜杠失效 | 一律用正斜杠 `/` |
| 环境 | python/python3 不可用 | 显式指定 python.exe 绝对路径 |
| 代码执行 | 内联长代码易出错 | 写 .py 文件再执行 |
