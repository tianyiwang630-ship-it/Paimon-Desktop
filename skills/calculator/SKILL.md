---
name: calculator
description: Python-based arithmetic calculator for performing mathematical operations. Use when the user needs to perform calculations, arithmetic operations, or mathematical computations including addition, subtraction, multiplication, division, exponentiation, and more complex mathematical expressions.
---

# Calculator Skill

This skill provides Python-based arithmetic calculation capabilities.

## Quick Start

For simple calculations, use the calculate script:

```python
from scripts.calculate import calculate

result = calculate("12 * 122")
print(result)  # 1464
```

## Usage

The calculator supports all standard Python arithmetic operations:

- **Basic operations**: `+`, `-`, `*`, `/`
- **Exponentiation**: `**`
- **Modulo**: `%`
- **Parentheses**: `( )`
- **Complex expressions**: `2 * (3 + 4) / 5`

## Examples

```python
# Basic arithmetic
calculate("12 * 122")        # 1464
calculate("100 / 4")         # 25.0
calculate("2 ** 10")         # 1024

# Complex expressions
calculate("(10 + 5) * 2")    # 30
calculate("100 % 7")         # 2
```

## Error Handling

The calculator will return error messages for:
- Invalid expressions
- Division by zero
- Syntax errors

Always check the result type or handle exceptions appropriately.
