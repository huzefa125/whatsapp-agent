import { z } from 'zod';
import { ToolError, type ToolDefinition } from '../types';

const MAX_DEPTH = 32;

/**
 * Recursive-descent evaluator for + - * / % ^ and parentheses over decimal numbers.
 * Deliberately NOT eval/Function: model-supplied text is never executed as code.
 */
export function evaluateExpression(source: string): number {
  let pos = 0;
  let depth = 0;

  const peek = (): string => source[pos] ?? '';
  const skipSpace = (): void => {
    while (peek() === ' ') pos++;
  };

  function parseExpression(): number {
    let value = parseTerm();
    for (;;) {
      skipSpace();
      const op = peek();
      if (op !== '+' && op !== '-') return value;
      pos++;
      const rhs = parseTerm();
      value = op === '+' ? value + rhs : value - rhs;
    }
  }

  function parseTerm(): number {
    let value = parsePower();
    for (;;) {
      skipSpace();
      const op = peek();
      if (op !== '*' && op !== '/' && op !== '%') return value;
      pos++;
      const rhs = parsePower();
      if ((op === '/' || op === '%') && rhs === 0) {
        throw new ToolError('DIVISION_BY_ZERO', 'Division by zero is undefined.');
      }
      value = op === '*' ? value * rhs : op === '/' ? value / rhs : value % rhs;
    }
  }

  function parsePower(): number {
    const base = parseUnary();
    skipSpace();
    if (peek() === '^') {
      pos++;
      return Math.pow(base, parsePower()); // right-associative
    }
    return base;
  }

  function parseUnary(): number {
    skipSpace();
    const c = peek();
    if (c === '-') {
      pos++;
      return -parseUnary();
    }
    if (c === '+') {
      pos++;
      return parseUnary();
    }
    return parsePrimary();
  }

  function parsePrimary(): number {
    skipSpace();
    if (peek() === '(') {
      if (++depth > MAX_DEPTH) throw new ToolError('EXPRESSION_TOO_COMPLEX', 'Expression is nested too deeply.');
      pos++;
      const value = parseExpression();
      skipSpace();
      if (peek() !== ')') throw new ToolError('SYNTAX_ERROR', 'Missing closing parenthesis.');
      pos++;
      depth--;
      return value;
    }
    const match = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(source.slice(pos));
    if (!match) {
      throw new ToolError('SYNTAX_ERROR', `Unexpected character at position ${pos + 1}.`);
    }
    pos += match[0].length;
    return Number(match[0]);
  }

  const result = parseExpression();
  skipSpace();
  if (pos < source.length) {
    throw new ToolError('SYNTAX_ERROR', `Unexpected character at position ${pos + 1}.`);
  }
  if (!Number.isFinite(result)) {
    throw new ToolError('RESULT_OUT_OF_RANGE', 'The result is not a finite number.');
  }
  return result;
}

const inputSchema = z
  .object({
    expression: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .describe('Arithmetic expression using numbers, + - * / % ^ and parentheses, e.g. "(12.5 + 7) * 3"'),
  })
  .strict();

const outputSchema = z.object({ expression: z.string(), result: z.number() });

type CalculatorInput = z.infer<typeof inputSchema>;
type CalculatorOutput = z.infer<typeof outputSchema>;

/** Harmless built-in tool used to exercise and demonstrate the engine. No I/O, no side effects. */
export const calculatorTool: ToolDefinition<CalculatorInput, CalculatorOutput> = {
  name: 'calculator',
  description:
    'Evaluates an arithmetic expression exactly. Use it for any calculation instead of computing in your head. Supports + - * / % ^ and parentheses.',
  inputSchema,
  outputSchema,
  permissions: ['utility:read'],
  sideEffect: 'none',
  requiresConfirmation: false,
  timeoutMs: 2000,
  retry: { maxRetries: 0, backoffMs: 0 },
  async execute({ expression }) {
    return { expression, result: evaluateExpression(expression) };
  },
};
