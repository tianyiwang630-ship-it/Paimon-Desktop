# Calculator Skill

A Python-based arithmetic calculator skill for performing mathematical operations.

## Features

- Basic arithmetic: `+`, `-`, `*`, `/`
- Exponentiation: `**`
- Modulo: `%`
- Parentheses support: `( )`
- Complex expressions
- Safe evaluation with input validation

## Usage

### Command Line

```bash
cd calculator
python scripts/calculate.py "12 * 122"
```

### Python API

```python
from calculator.scripts.calculate import calculate

result = calculate("12 * 122")
print(result)  # 1464
```

## Examples

| Expression | Result |
|------------|--------|
| `12 * 122` | 1464 |
| `100 / 4` | 25 |
| `2 ** 10` | 1024 |
| `(10 + 5) * 2` | 30 |
| `100 % 7` | 2 |

## Testing

Run the test script:

```bash
cd workspace
python test_calculator.py
```

## Skill Structure

```
calculator/
├── SKILL.md              # Skill definition
├── README.md             # This file
└── scripts/
    └── calculate.py      # Calculator implementation
Script execution complete.
Let me know if you'd like me to help with (optional):
- Packaging this skill into a .skill file
- Adding more mathematical functions (sqrt, sin, cos, etc.)
- Integrating with the Agent system
- Creating additional test cases
```

## File Structure

```
workspace/calculator/
├── SKILL.md              # Skill definition with metadata
├── README.md             # This documentation
└── scripts/
    └── calculate.py      # Calculator implementation
```

## Error Handling

The calculator provides clear error messages for:
- Invalid characters in expressions
- Division by zero
- Syntax errors
- Empty expressions

## Integration

This skill can be integrated with the Agent system by adding it to the `skills/` directory or by packaging it as a `.skill` file.
