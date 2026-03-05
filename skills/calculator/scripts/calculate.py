"""
Python Calculator Script
Performs arithmetic calculations using Python's eval() with safety restrictions.
"""


def calculate(expression: str) -> float:
    """
    Safely evaluate a mathematical expression.

    Args:
        expression: A string containing a mathematical expression
                   (e.g., "12 * 122", "2 + 3 * 4")

    Returns:
        The result of the calculation as a float (or int if applicable)

    Raises:
        ValueError: If the expression is invalid
        ZeroDivisionError: If division by zero occurs
    """
    # Remove any whitespace
    expression = expression.strip()

    if not expression:
        raise ValueError("Empty expression")

    # Define allowed characters for safety
    allowed_chars = set('0123456789+-*/().% ')

    # Check for any disallowed characters
    for char in expression:
        if char not in allowed_chars:
            raise ValueError(f"Invalid character in expression: '{char}'")

    try:
        # Evaluate the expression
        result = eval(expression, {"__builtins__": {}}, {})

        # Convert to int if it's a whole number
        if isinstance(result, float) and result.is_integer():
            result = int(result)

        return result

    except ZeroDivisionError:
        raise ZeroDivisionError("Division by zero")
    except SyntaxError:
        raise ValueError(f"Invalid expression syntax: {expression}")
    except Exception as e:
        raise ValueError(f"Error evaluating expression: {e}")


def main():
    """Command-line interface for the calculator."""
    import sys

    if len(sys.argv) < 2:
        print("Usage: python calculate.py '<expression>'")
        print("Example: python calculate.py '12 * 122'")
        sys.exit(1)

    expression = ' '.join(sys.argv[1:])

    try:
        result = calculate(expression)
        print(result)
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
